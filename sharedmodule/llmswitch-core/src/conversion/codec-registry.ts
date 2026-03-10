import type { ConversionCodec } from './types.js';
import { OpenAIOpenAIPipelineCodec } from './pipeline/codecs/v2/openai-openai-pipeline.js';
import { AnthropicOpenAIPipelineCodec } from './pipeline/codecs/v2/anthropic-openai-pipeline.js';
import { ResponsesOpenAIPipelineCodec } from './pipeline/codecs/v2/responses-openai-pipeline.js';

export type CodecFactory = () => Promise<ConversionCodec> | ConversionCodec;

export class CodecRegistry {
  private readonly factories = new Map<string, CodecFactory>();
  private readonly instances = new Map<string, ConversionCodec>();

  constructor(_deps?: unknown) {}

  register(id: string, factory: CodecFactory): void {
    this.factories.set(id, factory);
  }

  async resolve(id: string): Promise<ConversionCodec> {
    if (this.instances.has(id)) {
      return this.instances.get(id)!;
    }
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`Unknown conversion codec: ${id}`);
    }
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
  return {
    'openai-openai': () => new OpenAIOpenAIPipelineCodec(),
    'openai-openai-v2': () => new OpenAIOpenAIPipelineCodec(),
    'anthropic-openai': () => new AnthropicOpenAIPipelineCodec(),
    'anthropic-openai-v2': () => new AnthropicOpenAIPipelineCodec(),
    'responses-openai': () => new ResponsesOpenAIPipelineCodec(),
    'responses-openai-v2': () => new ResponsesOpenAIPipelineCodec()
  };
}
