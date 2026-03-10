import type { BaseSseEvent, StreamDirection } from './core-interfaces.js';
import type { ChatReasoningMode } from './chat-types.js';

/**
 * Anthropic JSON/SSE 类型定义与转换上下文
 */

export interface AnthropicContentTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicContentThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface AnthropicContentToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicContentToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicContentTextBlock
  | AnthropicContentThinkingBlock
  | AnthropicContentToolUseBlock
  | AnthropicContentToolResultBlock;

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant' | 'user';
  model: string;
  content: AnthropicContentBlock[];
  usage?: Record<string, unknown> & { input_tokens?: number; output_tokens?: number };
  stop_reason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string | null;
}

// --- Stats & Contexts -------------------------------------------------------

export interface AnthropicEventStats {
  totalEvents: number;
  contentBlocks: number;
  toolUseBlocks: number;
  thinkingBlocks: number;
  textBlocks: number;
  errors: number;
  startTime: number;
  endTime?: number;
}

export interface AnthropicJsonToSseContext {
  requestId: string;
  model: string;
  response: AnthropicMessageResponse;
  options: AnthropicJsonToSseOptions;
  startTime: number;
  eventStats: AnthropicEventStats;
}

export interface SseToAnthropicJsonContext {
  requestId: string;
  model?: string;
  startTime: number;
  eventStats: AnthropicEventStats;
  isCompleted: boolean;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface AnthropicJsonToSseOptions {
  requestId: string;
  model: string;
  chunkSize?: number;
  chunkDelayMs?: number;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export interface SseToAnthropicJsonOptions {
  requestId: string;
  model?: string;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export const DEFAULT_ANTHROPIC_CONVERSION_CONFIG = {
  defaultChunkSize: 1024,
  defaultDelayMs: 0,
  enableEventValidation: true,
  strictMode: false,
  reasoningMode: 'channel' as ChatReasoningMode,
  reasoningTextPrefix: undefined as string | undefined
};

// --- SSE Event definitions ---------------------------------------------------

export type AnthropicSseEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop';

export interface AnthropicSseEventBase<T extends AnthropicSseEventType = AnthropicSseEventType>
  extends BaseSseEvent {
  type: T;
  event?: T;
  protocol: 'anthropic-messages';
  direction: StreamDirection;
  data: unknown;
}

export interface AnthropicSseEventMessageStart extends AnthropicSseEventBase<'message_start'> {
  data: {
    type: 'message_start';
    message: { id: string; type: 'message'; role: 'assistant'; model: string };
  };
}

export interface AnthropicSseEventContentBlockStart extends AnthropicSseEventBase<'content_block_start'> {
  data: {
    type: 'content_block_start';
    index: number;
    content_block:
      | { type: 'text'; text?: string }
      | { type: 'thinking'; text?: string }
      | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
      | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean };
  };
}

export interface AnthropicSseEventContentBlockDelta extends AnthropicSseEventBase<'content_block_delta'> {
  data: {
    type: 'content_block_delta';
    index: number;
    delta:
      | { type: 'text_delta'; text: string }
      | { type: 'thinking_delta'; text: string }
      | { type: 'input_json_delta'; partial_json: string }
      | { type: 'output_json_delta'; partial_json: string };
  };
}

export interface AnthropicSseEventContentBlockStop extends AnthropicSseEventBase<'content_block_stop'> {
  data: {
    type: 'content_block_stop';
    index: number;
  };
}

export interface AnthropicSseEventMessageDelta extends AnthropicSseEventBase<'message_delta'> {
  data: {
    type: 'message_delta';
    delta?: { stop_reason?: AnthropicMessageResponse['stop_reason']; stop_sequence?: string | null; usage?: AnthropicMessageResponse['usage'] };
  };
}

export interface AnthropicSseEventMessageStop extends AnthropicSseEventBase<'message_stop'> {
  data: {
    type: 'message_stop';
  };
}

export type AnthropicSseEvent =
  | AnthropicSseEventMessageStart
  | AnthropicSseEventContentBlockStart
  | AnthropicSseEventContentBlockDelta
  | AnthropicSseEventContentBlockStop
  | AnthropicSseEventMessageDelta
  | AnthropicSseEventMessageStop;

export type AnthropicSseEventStream = AsyncIterable<string> | AsyncIterable<Buffer>;
