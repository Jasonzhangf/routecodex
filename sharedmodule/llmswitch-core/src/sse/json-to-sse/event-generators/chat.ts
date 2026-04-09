/**
 * Chat协议事件生成器
 * 提供纯函数，将Chat响应数据转换为SSE事件对象，不处理流写入
 */

import type { ChatSseEvent, ChatCompletionResponse, ChatToolCall, ChatUsage } from '../../types/index.js';
import { IdUtils, TimeUtils } from '../../shared/utils.js';

// 生成器配置
export interface ChatEventGeneratorConfig {
  chunkSize: number;
  chunkDelayMs: number;
  enableIdGeneration: boolean;
  enableTimestampGeneration: boolean;
}

// 事件生成上下文
export interface ChatEventGeneratorContext {
  model: string;
  requestId: string;
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

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }
  return undefined;
}

function normalizeChatUsage(usage: unknown): ChatUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const promptTokens = readNonNegativeInteger(
    record.prompt_tokens ?? record.input_tokens ?? record.promptTokens ?? record.inputTokens
  );
  const completionTokens = readNonNegativeInteger(
    record.completion_tokens ?? record.output_tokens ?? record.completionTokens ?? record.outputTokens
  );
  const totalTokens = readNonNegativeInteger(
    record.total_tokens ??
      record.totalTokens ??
      ((promptTokens ?? 0) + (completionTokens ?? 0) > 0
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined)
  );
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return undefined;
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
export function createDefaultContext(model: string, requestId: string): ChatEventGeneratorContext {
  return {
    model,
    requestId,
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
  return {
    id: config.enableIdGeneration ? IdUtils.generateRequestId() : context.requestId,
    object: 'chat.completion.chunk',
    created: config.enableTimestampGeneration ? Math.floor(TimeUtils.now() / 1000) : 0,
    model: context.model
  };
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

  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: { role: role as 'user' | 'system' | 'assistant' | 'tool' },
      logprobs: null,
      finish_reason: null
    }]
  };

  return [{
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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
  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: { reasoning, reasoning_content: reasoning },
      logprobs: null,
      finish_reason: null
    }]
  };

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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
  const chunk = {
    ...baseChunk,
    choices: [{
      index: context.choiceIndex,
      delta: { content },
      logprobs: null,
      finish_reason: null
    }]
  };

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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
            name: toolCall.function.name
          }
        }]
      },
      logprobs: null,
      finish_reason: null
    }]
  };

  return {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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

  yield {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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

  return {
    event: 'chat_chunk',
    type: 'chat_chunk',
    timestamp: TimeUtils.now(),
    data: JSON.stringify(chunk),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
  };
}

/**
 * 构建done事件
 */
export function buildDoneEvent(
  context: ChatEventGeneratorContext,
  config: ChatEventGeneratorConfig = DEFAULT_CHAT_EVENT_GENERATOR_CONFIG
): ChatSseEvent {
  return {
    event: 'chat.done',
    type: 'chat.done',
    timestamp: TimeUtils.now(),
    data: '[DONE]',
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
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
  return {
    event: 'error',
    type: 'error',
    timestamp: TimeUtils.now(),
    data: JSON.stringify({
      error: {
        message: error.message,
        type: 'internal_error',
        code: 'generation_error'
      }
    }),
    sequenceNumber: 0,
    protocol: 'chat' as const,
    direction: 'json_to_sse' as const
  };
}
