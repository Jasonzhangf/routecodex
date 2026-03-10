import type { AdapterContext, ChatEnvelope } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject } from '../types/json.js';

export interface FormatAdapter<
  TRequestPayload extends JsonObject = JsonObject,
  TResponsePayload extends JsonObject = JsonObject
> {
  readonly protocol: string;
  parseRequest(original: TRequestPayload, ctx: AdapterContext): Promise<FormatEnvelope<TRequestPayload>> | FormatEnvelope<TRequestPayload>;
  buildRequest(format: FormatEnvelope, ctx: AdapterContext): Promise<TRequestPayload> | TRequestPayload;
  parseResponse(original: TResponsePayload, ctx: AdapterContext): Promise<FormatEnvelope<TResponsePayload>> | FormatEnvelope<TResponsePayload>;
  buildResponse(format: FormatEnvelope, ctx: AdapterContext): Promise<TResponsePayload> | TResponsePayload;
}

export interface StageRecorder {
  record(stage: string, payload: object): void;
}

export interface SemanticMapper {
  toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> | ChatEnvelope;
  fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> | FormatEnvelope;
}

export { ChatFormatAdapter } from './chat-format-adapter.js';
export { AnthropicFormatAdapter } from './anthropic-format-adapter.js';
export { ResponsesFormatAdapter } from './responses-format-adapter.js';
export { GeminiFormatAdapter } from './gemini-format-adapter.js';
