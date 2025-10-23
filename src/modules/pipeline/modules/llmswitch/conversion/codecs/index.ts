import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { CodecFactory } from '../types.js';
import { AnthropicOpenAIConversionCodec } from './anthropic-openai-codec.js';
import { OpenAIOpenAIConversionCodec } from './openai-openai-codec.js';
import { ResponsesOpenAIConversionCodec } from './responses-openai-codec.js';

export function getDefaultCodecFactories(): Record<string, CodecFactory> {
  return {
    'anthropic-openai': (deps: ModuleDependencies) => new AnthropicOpenAIConversionCodec(deps),
    'openai-openai': (deps: ModuleDependencies) => new OpenAIOpenAIConversionCodec(deps),
    'responses-openai': (deps: ModuleDependencies) => new ResponsesOpenAIConversionCodec(deps)
  };
}
