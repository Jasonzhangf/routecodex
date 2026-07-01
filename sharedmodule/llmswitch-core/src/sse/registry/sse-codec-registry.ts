// feature_id: sse.codec_registry_surface
import type { Readable } from 'node:stream';
import type {
  ChatCompletionResponse,
  ResponsesResponse,
  AnthropicMessageResponse,
  GeminiResponse
} from '../types/index.js';
import type { ChatSseEventStream } from '../types/chat-types.js';
import type { ResponsesSseEventStream } from '../types/responses-types.js';
import { ChatJsonToSseConverter } from '../json-to-sse/index.js';
import { ChatSseToJsonConverter } from '../sse-to-json/index.js';
import { ResponsesJsonToSseConverter } from '../json-to-sse/index.js';
import { ResponsesSseToJsonConverter } from '../sse-to-json/index.js';
import { AnthropicJsonToSseConverter } from '../json-to-sse/anthropic-json-to-sse-converter.js';
import { AnthropicSseToJsonConverter } from '../sse-to-json/anthropic-sse-to-json-converter.js';
import { GeminiJsonToSseConverter } from '../json-to-sse/gemini-json-to-sse-converter.js';
import { GeminiSseToJsonConverter } from '../sse-to-json/gemini-sse-to-json-converter.js';

export type SseProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

export type SseStreamLike = Readable | ChatSseEventStream | ResponsesSseEventStream;
export type SseStreamInput = Readable | AsyncIterable<string | Buffer>;

export interface JsonToSseContext {
  requestId: string;
  model?: string;
  direction?: 'request' | 'response';
}

export interface SseToJsonContext {
  requestId: string;
  model?: string;
  direction?: 'request' | 'response';
  abortSignal?: AbortSignal;
  firstFrameTimeoutMs?: number;
  noContentTimeoutMs?: number;
  preAnchorIdleTimeoutMs?: number;
  contentIdleTimeoutMs?: number;
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

function resolveModelId(payload: unknown, contextModel?: string): string {
  if (typeof contextModel === 'string' && contextModel.trim()) {
    return contextModel.trim();
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.model === 'string' && record.model.trim()) {
      return record.model.trim();
    }
    if (typeof record.modelVersion === 'string' && record.modelVersion.trim()) {
      return record.modelVersion.trim();
    }
    if (record.response && typeof record.response === 'object') {
      const inner = record.response as Record<string, unknown>;
      if (typeof inner.model === 'string' && inner.model.trim()) {
        return inner.model.trim();
      }
      if (typeof inner.modelVersion === 'string' && inner.modelVersion.trim()) {
        return inner.modelVersion.trim();
      }
    }
  }
  throw new Error('Missing SSE model id');
}

function createChatCodec(): SseCodec {
  const jsonToSse = new ChatJsonToSseConverter();
  const sseToJson = new ChatSseToJsonConverter();
  return {
    protocol: 'openai-chat',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return await jsonToSse.convertResponseToJsonToSse(payload as ChatCompletionResponse, {
        requestId: context.requestId,
        model
      });
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: resolveModelId(undefined, context.model),
        abortSignal: context.abortSignal,
        firstFrameTimeoutMs: context.firstFrameTimeoutMs,
        noContentTimeoutMs: context.noContentTimeoutMs,
        preAnchorIdleTimeoutMs: context.preAnchorIdleTimeoutMs,
        contentIdleTimeoutMs: context.contentIdleTimeoutMs
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createResponsesCodec(): SseCodec {
  const jsonToSse = new ResponsesJsonToSseConverter();
  const sseToJson = new ResponsesSseToJsonConverter();
  return {
    protocol: 'openai-responses',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return await jsonToSse.convertResponseToJsonToSse(payload as ResponsesResponse, {
        requestId: context.requestId,
        model
      });
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: resolveModelId(undefined, context.model),
        abortSignal: context.abortSignal,
        firstFrameTimeoutMs: context.firstFrameTimeoutMs,
        noContentTimeoutMs: context.noContentTimeoutMs,
        preAnchorIdleTimeoutMs: context.preAnchorIdleTimeoutMs,
        contentIdleTimeoutMs: context.contentIdleTimeoutMs
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createAnthropicCodec(): SseCodec {
  const jsonToSse = new AnthropicJsonToSseConverter();
  const sseToJson = new AnthropicSseToJsonConverter();
  return {
    protocol: 'anthropic-messages',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return await jsonToSse.convertResponseToJsonToSse(payload as AnthropicMessageResponse, {
        requestId: context.requestId,
        model
      });
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: context.model,
        abortSignal: context.abortSignal,
        firstFrameTimeoutMs: context.firstFrameTimeoutMs,
        noContentTimeoutMs: context.noContentTimeoutMs,
        preAnchorIdleTimeoutMs: context.preAnchorIdleTimeoutMs,
        contentIdleTimeoutMs: context.contentIdleTimeoutMs
      });
    },
    async normalize(stream: SseStreamInput): Promise<SseStreamInput> {
      return stream;
    }
  };
}

function createGeminiCodec(): SseCodec {
  const jsonToSse = new GeminiJsonToSseConverter();
  const sseToJson = new GeminiSseToJsonConverter();
  return {
    protocol: 'gemini-chat',
    async convertJsonToSse(payload: unknown, context: JsonToSseContext): Promise<SseStreamLike> {
      const model = resolveModelId(payload, context.model);
      return await jsonToSse.convertResponseToJsonToSse(payload as GeminiResponse, {
        requestId: context.requestId,
        model
      });
    },
    async convertSseToJson(stream: SseStreamInput, context: SseToJsonContext): Promise<unknown> {
      return sseToJson.convertSseToJson(stream, {
        requestId: context.requestId,
        model: context.model,
        abortSignal: context.abortSignal
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
