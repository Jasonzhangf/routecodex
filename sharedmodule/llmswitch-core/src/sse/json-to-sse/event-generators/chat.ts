/**
 * Chat协议事件生成器
 * 提供纯函数，将Chat响应数据转换为SSE事件对象，不处理流写入
 */

import type { ChatSseEvent, ChatCompletionResponse, ChatToolCall, ChatUsage } from '../../types/index.js';
import {
  buildChatSseContentDeltaPayloadWithNative,
  buildChatSseErrorPayloadWithNative,
  buildChatSseEventEnvelopeWithNative,
  buildChatSseReasoningDeltaPayloadWithNative,
  buildChatSseRoleDeltaPayloadWithNative
} from '../../../native/router-hotpath/native-chat-sse-event-payload.js';

// 生成器配置
export interface ChatEventGeneratorConfig {
  chunkSize: number;
  chunkDelayMs: number;
  enableIdGeneration: boolean;
  enableTimestampGeneration: boolean;
  includeSequenceNumbers?: boolean;
}

// 事件生成上下文
export interface ChatEventGeneratorContext {
  model: string;
  requestId: string;
  responseId?: string;
  created?: number;
  sequenceCounter: number;
  choiceIndex: number;
  toolCallIndexCounter: number;
  contentIndexCounter: Map<string, number>;
}

// 默认配置
export const DEFAULT_CHAT_EVENT_GENERATOR_CONFIG: ChatEventGeneratorConfig = {
  chunkSize: 12,
  chunkDelayMs: 8,
  enableIdGeneration: true,
  enableTimestampGeneration: true
};

function readNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }
  throw new Error(`Invalid Chat usage.${fieldName}`);
}

function normalizeChatUsage(usage: unknown): ChatUsage | undefined {
  if (typeof usage === 'undefined' || usage === null) {
    return undefined;
  }
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('Invalid Chat usage: expected object');
  }
  const record = usage as Record<string, unknown>;
  const promptTokens = readNonNegativeInteger(record.prompt_tokens, 'prompt_tokens');
  const completionTokens = readNonNegativeInteger(record.completion_tokens, 'completion_tokens');
  const totalTokens = readNonNegativeInteger(record.total_tokens, 'total_tokens');
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    throw new Error('Invalid Chat usage: missing token fields');
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

/**
 * 创建默认上下文
 */
export function createDefaultContext(
  model: string,
  requestId: string,
  responseId?: string,
  created?: number
): ChatEventGeneratorContext {
  return {
    model,
    requestId,
    ...(typeof responseId === 'string' && responseId.trim() ? { responseId: responseId.trim() } : {}),
    ...(typeof created === 'number' && Number.isFinite(created) ? { created: Math.floor(created) } : {}),
    sequenceCounter: 0,
    choiceIndex: 0,
    toolCallIndexCounter: 0,
    contentIndexCounter: new Map()
  };
}

/**
 * 生成基础chunk数据
 */
function createBaseChunk(
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
} {
  if (typeof context.responseId !== 'string' || !context.responseId.trim()) {
    throw new Error('Invalid Chat response context: missing response id');
  }
  if (typeof context.created !== 'number' || !Number.isFinite(context.created) || context.created <= 0) {
    throw new Error('Invalid Chat response context: missing created timestamp');
  }
  return {
    id: context.responseId,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model
  };
}

function nextChatEventEnvelope(
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig
): {
  requestId: string;
  timestamp: number;
  sequenceNumber: number;
  protocol: 'chat';
  direction: 'json_to_sse';
} {
  const envelope = buildChatSseEventEnvelopeWithNative({
    requestId: context.requestId,
    currentSequence: context.sequenceCounter,
    enableTimestampGeneration: config.enableTimestampGeneration,
    enableSequenceNumbers: config.includeSequenceNumbers !== false
  });
  context.sequenceCounter = envelope.nextSequenceCounter;
  return envelope;
}

/**
 * 构建role delta事件
 */
export function buildRoleDelta(
  role: string,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): ChatSseEvent[] {
  const baseChunk = createBaseChunk(context, config);
  const payload = buildChatSseRoleDeltaPayloadWithNative({
    responseId: baseChunk.id,
    created: baseChunk.created,
    model: baseChunk.model,
    choiceIndex: context.choiceIndex,
    role
  });
  const envelope = nextChatEventEnvelope(context, config);

  return [{
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(payload),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  }];
}

/**
 * 构建reasoning delta事件
 */
export function* buildReasoningDeltas(
  reasoning: string,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): Generator<ChatSseEvent> {
  if (!reasoning) return;
  const baseChunk = createBaseChunk(context, config);
  const payload = buildChatSseReasoningDeltaPayloadWithNative({
    responseId: baseChunk.id,
    created: baseChunk.created,
    model: baseChunk.model,
    choiceIndex: context.choiceIndex,
    reasoning
  });
  const envelope = nextChatEventEnvelope(context, config);

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(payload),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建content delta事件
 */
export function* buildContentDeltas(
  content: string,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): Generator<ChatSseEvent> {
  if (!content) return;
  const baseChunk = createBaseChunk(context, config);
  const payload = buildChatSseContentDeltaPayloadWithNative({
    responseId: baseChunk.id,
    created: baseChunk.created,
    model: baseChunk.model,
    choiceIndex: context.choiceIndex,
    content
  });
  const envelope = nextChatEventEnvelope(context, config);

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(payload),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建tool_call开始事件
 */
export function buildToolCallStart(
  toolCall: ChatToolCall,
  toolCallIndex: number,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): ChatSseEvent {
  const baseChunk = createBaseChunk(context, config);

  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: {
        tool_calls: [{
          index: toolCallIndex,
          id: toolCall.id,
          type: toolCall.type || 'function',
          function: {
            name: toolCall.function.name,
            arguments: ''
          }
        }]
      },
      logprobs: null,
      finish_reason: null
    }]
  };
  const envelope = nextChatEventEnvelope(context, config);

  return {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(chunk),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建tool_call arguments delta事件
 */
export function* buildToolCallArgsDeltas(
  args: string,
  toolCallIndex: number,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): Generator<ChatSseEvent> {
  if (!args) return;
  const baseChunk = createBaseChunk(context, config);
  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: {
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: args }
        }]
      },
      logprobs: null,
      finish_reason: null
    }]
  };
  const envelope = nextChatEventEnvelope(context, config);

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(chunk),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建finish_reason事件
 */
export function buildFinishEvent(
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call',
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG,
  usage?: ChatCompletionResponse['usage']
): ChatSseEvent {
  const baseChunk = createBaseChunk(context, config);
  const normalizedUsage = normalizeChatUsage(usage);

  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: {},
      logprobs: null,
      finish_reason: finishReason
    }],
    ...(normalizedUsage ? { usage: normalizedUsage } : {})
  };
  const envelope = nextChatEventEnvelope(context, config);

  return {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: envelope.timestamp,
    data: JSON.stringify(chunk),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建done事件
 */
export function buildDoneEvent(
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): ChatSseEvent {
  const envelope = nextChatEventEnvelope(context, config);
  return {
    event: 'chat.done',
    type: 'chat.done',
    timestamp: envelope.timestamp,
    data: '[DONE]',
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}

/**
 * 构建error事件
 */
export function buildErrorEvent(
  error: Error,
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): ChatSseEvent {
  const envelope = nextChatEventEnvelope(context, config);
  return {
    event: 'error',
    type: 'error',
    timestamp: envelope.timestamp,
    data: JSON.stringify(buildChatSseErrorPayloadWithNative(error.message)),
    sequenceNumber: envelope.sequenceNumber,
    protocol: envelope.protocol,
    direction: envelope.direction
  };
}
