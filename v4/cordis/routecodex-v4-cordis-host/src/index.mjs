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
    return { nodeId: this.nodeId, state: 'draining', inFlight: 0 };
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

export function createNodePlugin(id, factory, config = undefined) {
  if (!id || typeof factory !== 'function') {
    throw new CordisHostError('invalid_plugin', 'plugin id and factory are required');
  }
  return Object.freeze({ id, factory, config });
}
