import type { FormatAdapter, SemanticMapper } from "../format-adapters/index.js";
import { ResponsesFormatAdapter } from "../format-adapters/responses-format-adapter.js";
import { ResponsesSemanticMapper } from "../semantic-mappers/responses-mapper.js";
import { AnthropicFormatAdapter } from "../format-adapters/anthropic-format-adapter.js";
import { AnthropicSemanticMapper } from "../semantic-mappers/anthropic-mapper.js";
import { GeminiFormatAdapter } from "../format-adapters/gemini-format-adapter.js";
import { GeminiSemanticMapper } from "../semantic-mappers/gemini-mapper.js";
import { ChatFormatAdapter } from "../format-adapters/chat-format-adapter.js";
import { ChatSemanticMapper } from "../semantic-mappers/chat-mapper.js";
import {
  runChatContextCapture,
  captureResponsesContextSnapshot,
} from "./stages/req_inbound/req_inbound_stage3_context_capture/index.js";
import {
  createResponsesContextCapture,
  createNoopContextCapture,
  type ContextCaptureFn,
} from "./stages/req_inbound/req_inbound_stage3_context_capture/context-factories.js";
import type { ProviderProtocol } from "./hub-pipeline.js";

export interface RequestStageHooks<TContext = Record<string, unknown>> {
  createFormatAdapter: () => FormatAdapter;
  createSemanticMapper: () => SemanticMapper;
  captureContext: ContextCaptureFn;
  contextMetadataKey?: string;
}

export const REQUEST_STAGE_HOOKS: Record<
  ProviderProtocol,
  RequestStageHooks<Record<string, unknown>>
> = {
  "openai-chat": {
    createFormatAdapter: () => new ChatFormatAdapter(),
    createSemanticMapper: () => new ChatSemanticMapper(),
    captureContext: (options) => runChatContextCapture(options),
    contextMetadataKey: "chatContext",
  },
  "openai-responses": {
    createFormatAdapter: () => new ResponsesFormatAdapter(),
    createSemanticMapper: () => new ResponsesSemanticMapper(),
    captureContext: createResponsesContextCapture(
      captureResponsesContextSnapshot,
    ),
    contextMetadataKey: "responsesContext",
  },
  "anthropic-messages": {
    createFormatAdapter: () => new AnthropicFormatAdapter(),
    createSemanticMapper: () => new AnthropicSemanticMapper(),
    captureContext: (options) => runChatContextCapture(options),
    contextMetadataKey: "anthropicContext",
  },
  "gemini-chat": {
    createFormatAdapter: () => new GeminiFormatAdapter(),
    createSemanticMapper: () => new GeminiSemanticMapper(),
    captureContext: createNoopContextCapture("gemini-chat"),
  },
};
