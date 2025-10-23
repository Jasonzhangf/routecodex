import type { ConversionCodec } from './types.js';

export type CodecFactory = () => Promise<ConversionCodec> | ConversionCodec;

export class CodecRegistry {
  private readonly factories = new Map<string, CodecFactory>();
  private readonly instances = new Map<string, ConversionCodec>();

  constructor(_deps?: unknown) {}

  register(id: string, factory: CodecFactory): void {
    this.factories.set(id, factory);
  }

  async resolve(id: string): Promise<ConversionCodec> {
    if (this.instances.has(id)) return this.instances.get(id)!;
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown conversion codec: ${id}`);
    const instance = await factory();
    await instance.initialize();
    this.instances.set(id, instance);
    return instance;
  }
}

// Default codec factories placeholder. In phase 1 we intentionally do not
// reimplement codecs here; the router will not be switched yet. This file is
// prepared so later phases can register actual codecs.
export function getDefaultCodecFactories(): Record<string, CodecFactory> {
  return {};
}

