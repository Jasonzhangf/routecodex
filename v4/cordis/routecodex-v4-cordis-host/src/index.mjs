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

const NODE_CONTAINER_STATES = new Set([
  'declared',
  'context_created',
  'plugins_mounted',
  'accepting',
  'draining',
  'disposed',
  'failed',
]);

const LIFECYCLE_OPERATIONS = new Set([
  'protocol_decode',
  'declare',
  'context_created',
  'plugins_mounted',
  'publish',
  'enter_execution',
  'exit_execution',
  'drain',
  'fail',
  'dispose',
  'status',
]);

const LIFECYCLE_FAILURE_CODES = new Set([
  'protocol_error',
  'plan_hash_mismatch',
  'binding_mismatch',
  'in_flight',
  'invalid_state',
  'host_lifecycle',
  'bridge_error',
]);

const EXECUTION_OPERATION = 'execute_node';
const EXECUTION_FAILURE_CODES = new Set([
  'plan_hash_mismatch',
  'invalid_state',
  'unregistered_handle',
  'handle_error',
  'effect_violation',
  'resource_access_violation',
  'bridge_error',
  'protocol_error',
]);

function decodeDiagnosticFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostError('binding_protocol', 'diagnostic fact must be an object');
  }
  const allowedKeys = new Set(['kind', 'plugin_id', 'message']);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CordisHostError('binding_protocol', `unknown diagnostic fact field ${unknown}`);
  }
  if (
    typeof value.kind !== 'string'
    || typeof value.plugin_id !== 'string'
    || typeof value.message !== 'string'
  ) {
    throw new CordisHostError('binding_protocol', 'diagnostic fact fields must be strings');
  }
}

function decodeExecutionOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostError('binding_protocol', 'execution output must be an object');
  }
  const allowedKeys = new Set(['data', 'control', 'information', 'diagnostics']);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CordisHostError('binding_protocol', `unknown execution output field ${unknown}`);
  }
  if (
    !Object.hasOwn(value, 'data')
    || !Object.hasOwn(value, 'control')
    || !Object.hasOwn(value, 'information')
  ) {
    throw new CordisHostError(
      'binding_protocol',
      'execution output requires data, control, and information',
    );
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new CordisHostError('binding_protocol', 'execution diagnostics must be an array');
  }
  for (const fact of value.diagnostics) {
    decodeDiagnosticFact(fact);
  }
}

function validateExecutionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostError('binding_protocol', 'execution input must be an object');
  }
  const allowedKeys = new Set(['data', 'control', 'information']);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CordisHostError('binding_protocol', `unknown execution input field ${unknown}`);
  }
  if (
    !Object.hasOwn(value, 'data')
    || !Object.hasOwn(value, 'control')
    || !Object.hasOwn(value, 'information')
  ) {
    throw new CordisHostError(
      'binding_protocol',
      'execution input requires data, control, and information',
    );
  }
}

function decodeExecutionResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostError('binding_protocol', 'execution response must be an object');
  }
  const failureKeys = new Set([
    'ok',
    'request_id',
    'state',
    'in_flight',
    'failure',
  ]);
  const successKeys = new Set(['ok', 'request_id', 'state', 'in_flight', 'output']);
  if (value.ok !== true && value.ok !== false) {
    throw new CordisHostError('binding_protocol', 'execution response ok must be boolean');
  }
  const allowedKeys = value.ok === true ? successKeys : failureKeys;
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CordisHostError('binding_protocol', `unknown execution response field ${unknown}`);
  }
  if (typeof value.request_id !== 'string' || value.request_id.length === 0) {
    throw new CordisHostError('binding_protocol', 'execution response request_id is required');
  }
  if (value.ok === true) {
    if (value.output === undefined) {
      throw new CordisHostError('binding_protocol', 'execution response requires typed output');
    }
    decodeExecutionOutput(value.output);
  } else {
    const failure = value.failure;
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
      throw new CordisHostError('binding_protocol', 'failed execution response requires failure fact');
    }
    if (
      failure.resource_id === 'v4.node_container.lifecycle_failure'
      && failure.operation === 'protocol_decode'
      && LIFECYCLE_FAILURE_CODES.has(failure.code)
    ) {
      if (
        failure.request_id !== value.request_id
        || typeof failure.message !== 'string'
        || failure.message.length === 0
      ) {
        throw new CordisHostError('binding_protocol', 'lifecycle failure fact is invalid');
      }
      return value;
    }
    if (failure.resource_id !== 'v4.node_container.execution_failure') {
      throw new CordisHostError('binding_protocol', 'execution failure resource id is invalid');
    }
    if (
      failure.operation !== EXECUTION_OPERATION
      || !EXECUTION_FAILURE_CODES.has(failure.code)
    ) {
      throw new CordisHostError('binding_protocol', 'execution failure fact is invalid');
    }
    if (
      failure.request_id !== value.request_id
      || typeof failure.message !== 'string'
      || failure.message.length === 0
      || (failure.node_id !== undefined && (
        typeof failure.node_id !== 'string' || failure.node_id.length === 0
      ))
    ) {
      throw new CordisHostError('binding_protocol', 'execution failure fact is invalid');
    }
  }
  return value;
}

function decodeLifecycleResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CordisHostError('binding_protocol', 'lifecycle response must be an object');
  }
  // Lifecycle success responses carry only typed lifecycle status; the typed
  // NodeExecutionOutput is reserved for the execute_node port surface, which
  // decodes the execution-specific schema in its own path.
  const successKeys = new Set(['ok', 'request_id', 'state', 'in_flight']);
  const failureKeys = new Set([...successKeys, 'failure']);
  const allowedKeys = value.ok === true ? successKeys : failureKeys;
  if (value.ok !== true && value.ok !== false) {
    throw new CordisHostError('binding_protocol', 'lifecycle response ok must be boolean');
  }
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CordisHostError('binding_protocol', `unknown lifecycle response field ${unknown}`);
  }
  if (typeof value.request_id !== 'string' || value.request_id.length === 0) {
    throw new CordisHostError('binding_protocol', 'lifecycle response request_id is required');
  }
  if (value.state !== undefined && !NODE_CONTAINER_STATES.has(value.state)) {
    throw new CordisHostError('binding_protocol', 'lifecycle response state is invalid');
  }
  if (value.in_flight !== undefined && (!Number.isSafeInteger(value.in_flight) || value.in_flight < 0)) {
    throw new CordisHostError('binding_protocol', 'lifecycle response in_flight is invalid');
  }
  if (value.ok === false) {
    const failure = value.failure;
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
      throw new CordisHostError('binding_protocol', 'failed lifecycle response requires failure fact');
    }
    const allowedFailureKeys = new Set([
      'resource_id',
      'request_id',
      'node_id',
      'operation',
      'code',
      'message',
    ]);
    const unknownFailure = Object.keys(failure).find((key) => !allowedFailureKeys.has(key));
    if (unknownFailure) {
      throw new CordisHostError('binding_protocol', `unknown lifecycle failure field ${unknownFailure}`);
    }
    if (failure.resource_id === 'v4.node_container.lifecycle_failure') {
      if (
        !LIFECYCLE_OPERATIONS.has(failure.operation)
        || !LIFECYCLE_FAILURE_CODES.has(failure.code)
      ) {
        throw new CordisHostError('binding_protocol', 'lifecycle failure fact is invalid');
      }
    } else if (failure.resource_id === 'v4.node_container.execution_failure') {
      if (
        failure.operation !== EXECUTION_OPERATION
        || !EXECUTION_FAILURE_CODES.has(failure.code)
      ) {
        throw new CordisHostError('binding_protocol', 'execution failure fact is invalid');
      }
    } else {
      throw new CordisHostError('binding_protocol', 'host failure resource id is invalid');
    }
    if (
      failure.request_id !== value.request_id
      || typeof failure.message !== 'string'
      || failure.message.length === 0
      || (failure.node_id !== undefined && (
        typeof failure.node_id !== 'string' || failure.node_id.length === 0
      ))
    ) {
      throw new CordisHostError('binding_protocol', 'lifecycle failure fact is invalid');
    }
  }
  return value;
}

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

export function cordisCatalogIdentityKey(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new CordisHostError('invalid_catalog_entry', 'catalog entry must be an object');
  }
  for (const field of ['plugin_id', 'version', 'artifact_hash']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new CordisHostError('invalid_catalog_entry', `catalog entry requires ${field}`);
    }
  }
  return `${entry.plugin_id}@${entry.version}+${entry.artifact_hash}`;
}

function catalogEntries(catalog) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.entries)) {
    throw new CordisHostError('invalid_catalog', 'canonical catalog entries are required');
  }
  const identities = new Set();
  return Object.freeze(catalog.entries.map((entry) => {
    const identity = cordisCatalogIdentityKey(entry);
    if (identities.has(identity)) {
      throw new CordisHostError('catalog_identity_conflict', `duplicate catalog identity ${identity}`);
    }
    identities.add(identity);
    return Object.freeze({ ...entry });
  }));
}

/**
 * Bind canonical catalog identities to real Cordis plugin factories.
 * The catalog is the only identity source; implementations provide behavior
 * and never carry request or response state.
 */
export function createCordisPluginFactory({ catalog, implementations }) {
  const entries = catalogEntries(catalog);
  if (!(implementations instanceof Map)) {
    throw new CordisHostError('invalid_catalog_implementations', 'implementations must be a Map');
  }
  const byIdentity = new Map(entries.map((entry) => [cordisCatalogIdentityKey(entry), entry]));
  for (const [identity, implementation] of implementations) {
    if (typeof identity !== 'string' || typeof implementation !== 'function') {
      throw new CordisHostError(
        'invalid_catalog_implementation',
        'implementation entries require an identity string and function',
      );
    }
    if (!byIdentity.has(identity)) {
      throw new CordisHostError(
        'catalog_implementation_mismatch',
        `implementation ${identity} is absent from canonical catalog`,
      );
    }
  }
  return Object.freeze({
    createPlugin(entry, config = undefined) {
      const identity = cordisCatalogIdentityKey(entry);
      const canonical = byIdentity.get(identity);
      if (!canonical) {
        throw new CordisHostError(
          'catalog_identity_mismatch',
          `plugin ${identity} is absent from canonical catalog`,
        );
      }
      const implementation = implementations.get(identity);
      if (!implementation) {
        throw new CordisHostError(
          'catalog_implementation_missing',
          `catalog plugin ${identity} has no Cordis implementation`,
        );
      }
      return createNodePlugin(
        canonical.plugin_id,
        (context, pluginConfig) => implementation(context, pluginConfig),
        config,
        entry,
      );
    },
    createPlugins(pluginEntries, configs = new Map()) {
      if (!Array.isArray(pluginEntries)) {
        throw new CordisHostError('invalid_plugin_entries', 'plugin entries must be an array');
      }
      if (!(configs instanceof Map)) {
        throw new CordisHostError('invalid_plugin_configs', 'plugin configs must be a Map');
      }
      return Object.freeze(pluginEntries.map((entry) => {
        const identity = cordisCatalogIdentityKey(entry);
        return this.createPlugin(entry, configs.get(identity));
      }));
    },
  });
}

export function computeNodePluginPlanHash(plan) {
  const { hash: _hash, ...body } = plan;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export class CordisHostError extends Error {
  constructor(code, message, failure = undefined) {
    super(message);
    this.name = 'CordisHostError';
    this.code = code;
    this.failure = failure;
  }
}

export class CordisNodeHost {
  #root;
  #pipeline;
  #node;
  #fibers = [];
  #disposed = false;
  #ready = false;
  #acquired = new Set();
  #releasedServices = new Set();
  #serviceBindings = new Map();

  constructor({ nodeId, services = [], descriptor, serviceBindings }) {
    if (!nodeId || !descriptor) {
      throw new CordisHostError('invalid_node_descriptor', 'nodeId and descriptor are required');
    }
    this.nodeId = nodeId;
    this.descriptor = Object.freeze({ ...descriptor });
    this.services = Object.freeze([...services]);
    if (serviceBindings !== undefined && !(serviceBindings instanceof Map)) {
      throw new CordisHostError(
        'invalid_service_bindings',
        'serviceBindings must be a Map of typed node service values',
      );
    }
    this.#serviceBindings = new Map(serviceBindings ? [...serviceBindings] : []);
    for (const name of this.#serviceBindings.keys()) {
      if (!this.services.includes(name)) {
        throw new CordisHostError(
          'service_not_declared',
          `node service ${name} bound without a host declaration`,
        );
      }
    }
    this.#root = new Context();
    this.#pipeline = this.#root.extend();
    this.#node = this.#pipeline.extend();
    for (const name of nodeServiceLabels(this.services)) {
      this.#node.isolate(name);
    }
  }

  acquireService(name) {
    if (this.#disposed) {
      throw new CordisHostError('service_disposed', `node service ${name} was released on dispose`);
    }
    if (!this.#ready) {
      throw new CordisHostError(
        'service_not_ready',
        `node service ${name} is not ready before host mount`,
      );
    }
    if (!this.services.includes(name)) {
      throw new CordisHostError(
        'service_not_declared',
        `node service ${name} is not declared for ${this.nodeId}`,
      );
    }
    const host = this;
    const token = Object.freeze({
      name,
      nodeId: host.nodeId,
      isValid() {
        if (host.#disposed) return false;
        if (!host.#ready) return false;
        if (!host.services.includes(name)) return false;
        if (host.#releasedServices.has(name)) return false;
        return true;
      },
    });
    this.#acquired.add(name);
    return token;
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
    for (const [name, value] of this.#serviceBindings) {
      this.#node.provide(name, value);
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
      this.#ready = true;
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
    const retained = [...this.#acquired];
    try {
      await this.#disposeFibers(this.#fibers);
    } finally {
      this.#ready = false;
      this.#fibers = [];
      for (const name of retained) {
        this.#releasedServices.add(name);
      }
      this.#acquired.clear();
      this.#disposed = true;
    }
  }

  async #disposeFibers(fibers) {
    const failures = [];
    for (const mounted of [...fibers].reverse()) {
      try {
        await mounted.fiber.dispose();
      } catch (error) {
        failures.push({ pluginId: mounted.id, error });
      }
    }
    if (failures.length > 0) {
      const summary = failures
        .map(({ pluginId, error }) => `${pluginId}: ${error?.message ?? String(error)}`)
        .join('; ');
      throw new CordisHostError('dispose_failure', `fiber disposal failed: ${summary}`, {
        resource_id: 'v4.cordis.plugin_fibers',
        operation: 'dispose',
        failures: failures.map(({ pluginId, error }) => ({
          plugin_id: pluginId,
          message: error?.message ?? String(error),
        })),
      });
    }
  }
}

export class RustNodeContainerPort {
  #child;
  #pending = new Map();
  #nextRequestId = 1;
  #protocolError;

  constructor({ binaryPath, binaryArgs = [] }) {
    if (!binaryPath) {
      throw new CordisHostError('invalid_binding', 'binaryPath is required');
    }
    if (!Array.isArray(binaryArgs) || binaryArgs.some((value) => typeof value !== 'string')) {
      throw new CordisHostError('invalid_binding', 'binaryArgs must be an array of strings');
    }
    this.#child = spawn(binaryPath, binaryArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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

  executeNode(planHash, input, ...extra) {
    if (extra.length > 0) this.#rejectFields('execute_node');
    if (typeof planHash !== 'string' || planHash.length !== 64) {
      throw new CordisHostError('binding_protocol', 'execute_node requires a sha256 plan hash');
    }
    validateExecutionInput(input);
    // Response decoding happens per-op in #settle: lifecycle responses run
    // through decodeLifecycleResponse (no `output`), execute_node runs
    // through decodeExecutionResponse (typed output). Re-decode here would
    // double-decode and risk schema drift.
    return this.#request({ op: 'execute_node', plan_hash: planHash, input });
  }

  status(...fields) {
    return this.#requestWithoutFields('status', fields);
  }

  async #request(message) {
    if (this.#protocolError) throw this.#protocolError;
    if (this.#child.exitCode !== null || !this.#child.stdin.writable) {
      throw new CordisHostError('binding_closed', 'Rust NodeContainer binding is closed');
    }
    const requestId = `host-${this.#nextRequestId++}`;
    const op = typeof message?.op === 'string' ? message.op : 'unknown';
    const response = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, op });
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
      throw new CordisHostError(value.failure.code, value.failure.message, value.failure);
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
    let parsed;
    let requestId = null;
    let pending = null;
    try {
      parsed = JSON.parse(line);
      requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : null;
      pending = requestId ? this.#pending.get(requestId) : undefined;
      if (!pending) {
        this.#failProtocol('lifecycle response has no matching pending request_id');
        return;
      }
    } catch (error) {
      this.#failProtocol(error.message);
      return;
    }
    if (!pending) return;
    let value;
    try {
      if (pending.op === 'execute_node') {
        value = decodeExecutionResponse(parsed);
      } else {
        value = decodeLifecycleResponse(parsed);
      }
    } catch (error) {
      this.#failProtocol(error.message);
      return;
    }
    this.#pending.delete(requestId);
    pending.resolve(value);
  }

  #failProtocol(message) {
    if (!this.#protocolError) {
      this.#protocolError = new CordisHostError('binding_protocol', message);
    }
    this.#rejectAll(this.#protocolError);
    if (this.#child.stdin.writable) this.#child.stdin.end();
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

  async executeNode(planHash, input) {
    if (!this.#mounted || this.disposed) {
      throw new CordisHostError('invalid_state', 'host is not accepting executions');
    }
    if (planHash !== this.#plan.hash) {
      throw new CordisHostError('plan_hash_mismatch', 'execution plan hash does not match host');
    }
    if (
      this.fibers.length === 0
      || this.fibers.some(({ fiber }) => fiber.state !== FiberState.ACTIVE)
    ) {
      throw new CordisHostError(
        'plugin_not_active',
        'Cordis plugin fibers must be ACTIVE before Rust plan execution',
      );
    }
    const response = await this.#port.executeNode(planHash, input);
    return response.output;
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

export {
  CORDIS_HOST_PROTOCOL_VERSION,
  CordisHostDaemonClient,
  CordisHostDaemonError,
  startCordisHostDaemon,
} from './daemon.mjs';
