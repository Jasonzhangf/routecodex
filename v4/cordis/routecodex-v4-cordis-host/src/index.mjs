import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { Context, FiberState } from 'cordis';

export const NODE_SERVICES = Object.freeze([
  'nodeDescriptor',
  'nodePlugins',
  'nodeExecution',
  'nodeControl',
  'nodeInformation',
  'nodeDiagnostics',
  'nodeErrors',
  'nodeLifecycle',
]);

const nodeServiceLabels = (services) => [
  ...NODE_SERVICES,
  ...services,
];

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function computeNodePluginPlanHash(plan) {
  const { hash: _hash, ...body } = plan;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export class CordisHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CordisHostError';
    this.code = code;
  }
}

export class CordisNodeHost {
  #root;
  #pipeline;
  #node;
  #fibers = [];
  #disposed = false;

  constructor({ nodeId, services = [], descriptor }) {
    if (!nodeId || !descriptor) {
      throw new CordisHostError('invalid_node_descriptor', 'nodeId and descriptor are required');
    }
    this.nodeId = nodeId;
    this.descriptor = Object.freeze({ ...descriptor });
    this.services = Object.freeze([...services]);
    this.#root = new Context();
    this.#pipeline = this.#root.extend();
    this.#node = this.#pipeline.extend();
    for (const name of nodeServiceLabels(this.services)) {
      this.#node.isolate(name);
    }
  }

  get context() {
    return this.#node;
  }

  get fibers() {
    return Object.freeze([...this.#fibers]);
  }

  get disposed() {
    return this.#disposed;
  }

  async mount(plugins) {
    if (this.#disposed) {
      throw new CordisHostError('host_disposed', `node ${this.nodeId} is disposed`);
    }
    const mounted = [];
    try {
      for (const plugin of plugins) {
        const fiber = this.#node.plugin(plugin.factory, plugin.config);
        mounted.push({ id: plugin.id, fiber });
        await fiber.await();
        if (fiber.state !== FiberState.ACTIVE) {
          throw new CordisHostError(
            'plugin_not_active',
            `plugin ${plugin.id} did not reach ACTIVE (state=${fiber.state})`,
          );
        }
      }
      this.#fibers = mounted;
      return this;
    } catch (error) {
      await this.#disposeFibers(mounted);
      throw error;
    }
  }

  async drain() {
    if (this.#disposed) {
      throw new CordisHostError('host_disposed', `node ${this.nodeId} is disposed`);
    }
    throw new CordisHostError(
      'unbound_lifecycle',
      'drain requires the Rust NodeContainer binding; use CordisBoundNodeHost',
    );
  }

  async dispose() {
    if (this.#disposed) return;
    await this.#disposeFibers(this.#fibers);
    this.#fibers = [];
    this.#disposed = true;
  }

  async #disposeFibers(fibers) {
    for (const mounted of [...fibers].reverse()) {
      await mounted.fiber.dispose();
    }
  }
}

export class RustNodeContainerPort {
  #child;
  #pending = new Map();
  #nextRequestId = 1;

  constructor({ binaryPath }) {
    if (!binaryPath) {
      throw new CordisHostError('invalid_binding', 'binaryPath is required');
    }
    this.#child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => this.#settle(line));
    this.#child.once('error', (cause) => {
      this.#rejectAll(new CordisHostError('binding_spawn', cause.message));
    });
    this.#child.once('exit', (code, signal) => {
      this.#rejectAll(new CordisHostError(
        'binding_exit',
        `Rust NodeContainer binding exited code=${code} signal=${signal}`,
      ));
    });
  }

  declare(nodeId, plan, bindings, ...extra) {
    if (extra.length > 0) this.#rejectFields('declare');
    return this.#request({ op: 'declare', node_id: nodeId, plan, bindings });
  }

  contextCreated(...fields) {
    return this.#requestWithoutFields('context_created', fields);
  }

  pluginsMounted(...fields) {
    return this.#requestWithoutFields('plugins_mounted', fields);
  }

  publish(...fields) {
    return this.#requestWithoutFields('publish', fields);
  }

  enterExecution(...fields) {
    return this.#requestWithoutFields('enter_execution', fields);
  }

  exitExecution(...fields) {
    return this.#requestWithoutFields('exit_execution', fields);
  }

  drain(...fields) {
    return this.#requestWithoutFields('drain', fields);
  }

  fail(...fields) {
    return this.#requestWithoutFields('fail', fields);
  }

  dispose(...fields) {
    return this.#requestWithoutFields('dispose', fields);
  }

  status(...fields) {
    return this.#requestWithoutFields('status', fields);
  }

  async #request(message) {
    if (this.#child.exitCode !== null || !this.#child.stdin.writable) {
      throw new CordisHostError('binding_closed', 'Rust NodeContainer binding is closed');
    }
    const requestId = `host-${this.#nextRequestId++}`;
    const response = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    this.#child.stdin.write(
      `${JSON.stringify({ ...message, request_id: requestId })}\n`,
      (cause) => {
        if (!cause) return;
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.reject(new CordisHostError('binding_write', cause.message));
      },
    );
    const value = await response;
    if (!value.ok) {
      throw new CordisHostError(value.code ?? 'binding_error', value.error ?? 'binding failed');
    }
    return value;
  }

  #requestWithoutFields(op, fields) {
    if (fields.length > 0) this.#rejectFields(op);
    return this.#request({ op });
  }

  #rejectFields(op) {
    throw new CordisHostError(
      'binding_protocol',
      `${op} does not accept undeclared lifecycle fields`,
    );
  }

  async close() {
    if (this.#child.exitCode !== null || this.#child.stdin.destroyed) return;
    this.#child.stdin.end();
    await new Promise((resolve) => {
      if (this.#child.exitCode !== null) resolve();
      else this.#child.once('exit', resolve);
    });
  }

  #settle(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#rejectAll(new CordisHostError('binding_protocol', error.message));
      return;
    }
    const pending = this.#pending.get(value.request_id);
    if (!pending) return;
    this.#pending.delete(value.request_id);
    pending.resolve(value);
  }

  #rejectAll(error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

export class CordisBoundNodeHost extends CordisNodeHost {
  #port;
  #plan;
  #mounted = false;

  constructor({ port, plan, ...hostOptions }) {
    super(hostOptions);
    if (!port || !plan) {
      throw new CordisHostError('invalid_binding', 'port and plan are required');
    }
    const computedHash = computeNodePluginPlanHash(plan);
    if (computedHash !== plan.hash) {
      throw new CordisHostError('plan_hash_mismatch', 'NodePluginPlan hash does not verify');
    }
    this.#port = port;
    this.#plan = Object.freeze(structuredClone(plan));
  }

  async mount(plugins) {
    this.#verifyGraph(plugins);
    const hash = this.#plan.hash;
    await this.#port.declare(this.nodeId, this.#plan, {
      graph_hash: hash,
      manifest_hash: hash,
      loaded_plan_hash: hash,
    });
    try {
      await this.#port.contextCreated();
      await super.mount(plugins);
      await this.#port.pluginsMounted();
      await this.#port.publish();
      this.#mounted = true;
      return this;
    } catch (error) {
      await this.#port.fail();
      await super.dispose();
      await this.#port.dispose();
      throw error;
    }
  }

  async beginExecution() {
    if (!this.#mounted || this.disposed) {
      throw new CordisHostError('invalid_state', 'host is not accepting executions');
    }
    await this.#port.enterExecution();
    let releaseRequest;
    return async () => {
      if (!releaseRequest) {
        releaseRequest = this.#port.exitExecution().catch((error) => {
          releaseRequest = undefined;
          throw error;
        });
      }
      await releaseRequest;
    };
  }

  async drain() {
    if (this.disposed) {
      throw new CordisHostError('host_disposed', `node ${this.nodeId} is disposed`);
    }
    const status = await this.#port.drain();
    return { nodeId: this.nodeId, state: status.state, inFlight: status.in_flight };
  }

  async dispose() {
    if (this.disposed) return;
    const status = await this.#port.status();
    if (status.state !== 'draining' && status.state !== 'failed') {
      throw new CordisHostError(
        'invalid_state',
        `cannot dispose Cordis host while Rust NodeContainer is ${status.state}`,
      );
    }
    await super.dispose();
    await this.#port.dispose();
    this.#mounted = false;
  }

  #verifyGraph(plugins) {
    const entries = plugins.map((plugin) => plugin.planEntry);
    if (entries.some((entry) => !entry)) {
      throw new CordisHostError('graph_binding_missing', 'every plugin requires planEntry');
    }
    if (canonicalJson(entries) !== canonicalJson(this.#plan.entries)) {
      throw new CordisHostError('graph_hash_mismatch', 'actual Cordis graph differs from plan');
    }
  }
}

export function createNodePlugin(id, factory, config = undefined, planEntry = undefined) {
  if (!id || typeof factory !== 'function') {
    throw new CordisHostError('invalid_plugin', 'plugin id and factory are required');
  }
  return Object.freeze({ id, factory, config, planEntry });
}
