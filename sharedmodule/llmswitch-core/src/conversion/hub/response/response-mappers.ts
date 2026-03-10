import type { FormatEnvelope } from '../types/format-envelope.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import { buildOpenAIChatFromGeminiResponse } from '../../codecs/gemini-openai-codec.js';
import { buildChatResponseFromResponses } from '../../shared/responses-response-utils.js';
import { buildOpenAIChatFromAnthropicMessage } from './response-runtime.js';
import type { JsonValue } from '../types/json.js';
import type { ChatSemantics } from '../types/chat-envelope.js';
import { resolveAliasMapFromRespSemanticsWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

export type ChatCompletionLike = JsonObject;

export interface ResponseMapper {
  toChatCompletion(
    format: FormatEnvelope,
    ctx: AdapterContext,
    options?: { requestSemantics?: ChatSemantics | JsonObject }
  ): Promise<ChatCompletionLike> | ChatCompletionLike;
}

function injectResponsesReasoningExtension(payload: JsonObject): void {
  if ((payload as any).__responses_reasoning) {
    return;
  }
  const choices = Array.isArray((payload as any).choices) ? (payload as any).choices : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message = primary && typeof (primary as any).message === 'object' ? (primary as any).message as Record<string, unknown> : undefined;
  if (!message) return;
  const reasoningText =
    typeof (message as any).reasoning_content === 'string' && (message as any).reasoning_content.trim().length
      ? String((message as any).reasoning_content).trim()
      : undefined;
  if (!reasoningText) return;
  (payload as any).__responses_reasoning = {
    content: [{ type: 'reasoning_text', text: reasoningText }]
  };
}

export class OpenAIChatResponseMapper implements ResponseMapper {
  toChatCompletion(format: FormatEnvelope, _ctx: AdapterContext): ChatCompletionLike {
    const payload = (format.payload ?? {}) as ChatCompletionLike;
    if (payload && typeof payload === 'object') {
      injectResponsesReasoningExtension(payload as JsonObject);
    }
    return payload;
  }
}

export class ResponsesResponseMapper implements ResponseMapper {
  toChatCompletion(format: FormatEnvelope, _ctx: AdapterContext): ChatCompletionLike {
    return buildChatResponseFromResponses(format.payload ?? {}) as ChatCompletionLike;
  }
}

export class AnthropicResponseMapper implements ResponseMapper {
  toChatCompletion(
    format: FormatEnvelope,
    _ctx: AdapterContext,
    options?: { requestSemantics?: ChatSemantics | JsonObject }
  ): ChatCompletionLike {
    const aliasMap = resolveAliasMapFromRespSemanticsWithNative(options?.requestSemantics);
    return buildOpenAIChatFromAnthropicMessage(format.payload ?? {}, { aliasMap });
  }
}

export class GeminiResponseMapper implements ResponseMapper {
  toChatCompletion(format: FormatEnvelope, _ctx: AdapterContext): ChatCompletionLike {
    return buildOpenAIChatFromGeminiResponse(format.payload ?? {});
  }
}
