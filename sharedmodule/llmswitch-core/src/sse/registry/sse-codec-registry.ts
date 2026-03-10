import { chatConverters, responsesConverters, anthropicConverters, geminiConverters } from '../index.js';
import type {
  ChatCompletionResponse,
  ResponsesResponse,
  AnthropicMessageResponse,
  ResponsesFunctionCallOutputItem,
  GeminiResponse
} from '../types/index.js';

export type SseProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

export type SseStreamLike = any;
export type SseStreamInput = any;

export interface JsonToSseContext {
  requestId: string;
  model?: string;
  direction?: 'request' | 'response';
  resumeToolOutputs?: ResponsesFunctionCallOutputItem[];
}

export interface SseToJsonContext {
  requestId: string;
  model?: string;
  direction?: 'request' | 'response';
}

export interface NormalizeSseContext {
  requestId: string;
  protocol: SseProtocol;
}

export interface SseCodec {
  protocol: SseProtocol;
  convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike>;
  convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown>;
  normalize?(stream: SseStreamInput, context: NormalizeSseContext): Promise<SseStreamInput>;
}

export class SseCodecRegistry {
  private readonly codecs = new Map<SseProtocol, SseCodec>();

  register(codec: SseCodec): void {
    this.codecs.set(codec.protocol, codec);
  }

  get(protocol: SseProtocol): SseCodec {
    const codec = this.codecs.get(protocol);
    if (!codec) {
      throw new Error(`SSE codec for protocol "${protocol}" is not registered`);
    }
    return codec;
  }

  list(): SseCodec[] {
    return Array.from(this.codecs.values());
  }
}

export const defaultSseCodecRegistry = new SseCodecRegistry();

function resolveModelId(payload: unknown, fallback?: string): string {
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback;
  }
  if (!payload || typeof payload !== 'object') {
    return 'unknown';
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.model === 'string') {
    return record.model;
  }
  if (record.modelVersion && typeof record.modelVersion === 'string') {
    return record.modelVersion;
  }
  if (record.response && typeof record.response === 'object') {
    const inner = record.response as Record<string, unknown>;
    if (typeof inner.model === 'string') {
      return inner.model;
    }
    if (typeof inner.modelVersion === 'string') {
      return inner.modelVersion;
    }
  }
  return 'unknown';
}

function createChatCodec(): SseCodec {
  return {
    protocol: 'openai-chat',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return chatConverters.jsonToSse
        .convertResponseToJsonToSse(payload as ChatCompletionResponse, {
          requestId: context.requestId,
          model
        }) as SseStreamLike;
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return chatConverters.sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: context.model ?? 'unknown'
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createResponsesCodec(): SseCodec {
  return {
    protocol: 'openai-responses',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return responsesConverters.jsonToSse
        .convertResponseToJsonToSse(payload as ResponsesResponse, {
          requestId: context.requestId,
          model,
          resumeToolOutputs: context.resumeToolOutputs
        }) as SseStreamLike;
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return responsesConverters.sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: context.model ?? 'unknown'
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createAnthropicCodec(): SseCodec {
  return {
    protocol: 'anthropic-messages',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return anthropicConverters.jsonToSse
        .convertResponseToJsonToSse(payload as AnthropicMessageResponse, {
          requestId: context.requestId,
          model
        }) as SseStreamLike;
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return anthropicConverters.sseToJson.convertSseToJson(stream, {
        requestId: context.requestId
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createGeminiCodec(): SseCodec {
  return {
    protocol: 'gemini-chat',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return geminiConverters.jsonToSse
        .convertResponseToJsonToSse(payload as GeminiResponse, {
          requestId: context.requestId,
          model
        }) as SseStreamLike;
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return geminiConverters.sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: context.model
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

defaultSseCodecRegistry.register(createChatCodec());
defaultSseCodecRegistry.register(createResponsesCodec());
defaultSseCodecRegistry.register(createAnthropicCodec());
defaultSseCodecRegistry.register(createGeminiCodec());
