import type { ModuleDependencies } from '../../../interfaces/pipeline-interfaces.js';
import type { CodecFactory, ConversionCodec } from './types.js';

export class CodecRegistry {
  private readonly factories: Map<string, CodecFactory> = new Map();
  private readonly instances: Map<string, ConversionCodec> = new Map();
  private readonly dependencies: ModuleDependencies;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
  }

  register(id: string, factory: CodecFactory): void {
    this.factories.set(id, factory);
  }

  async resolve(id: string): Promise<ConversionCodec> {
    if (this.instances.has(id)) {
      return this.instances.get(id)!;
    }

    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`No codec registered for id "${id}"`);
    }

    const instance = factory(this.dependencies);
    if (instance.initialize) {
      await instance.initialize();
    }
    this.instances.set(id, instance);
    return instance;
  }
}
