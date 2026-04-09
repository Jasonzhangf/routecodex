/**
 * Chat协议事件编排器
 * 负责严格的事件时序组合：role → content OR tool_calls(name → args.delta*) → finish_reason → done
 */

import type { ChatCompletionResponse, ChatReasoningMode, ChatSseEvent } from '../../types/index.js';
import {
  buildRoleDelta,
  buildReasoningDeltas,
  buildContentDeltas,
  buildToolCallStart,
  buildToolCallArgsDeltas,
  buildFinishEvent,
  buildDoneEvent,
  buildErrorEvent,
  DEFAULT_CHAT_EVENT_GENERATOR_CONFIG,
  createDefaultContext
} from '../event-generators/chat.js';
import type { ChatEventGeneratorContext, ChatEventGeneratorConfig } from '../event-generators/chat.js';
import { normalizeMessageReasoningTools } from '../../../conversion/shared/reasoning-tool-normalizer.js';
import { normalizeChatMessageContent } from '../../../conversion/shared/chat-output-normalizer.js';
import { dispatchReasoning } from '../../shared/reasoning-dispatcher.js';

// 排列器配置
export interface ChatSequencerConfig extends ChatEventGeneratorConfig {
  includeSequenceNumbers: boolean;
  enableDelay: boolean;
  validateOrder: boolean;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

// 默认配置
export const DEFAULT_CHAT_SEQUENCER_CONFIG: ChatSequencerConfig = {
  ...DEFAULT_CHAT_EVENT_GENERATOR_CONFIG,
  includeSequenceNumbers: true,
  enableDelay: false,
  validateOrder: true,
  reasoningMode: 'channel'
};

/**
 * 验证消息顺序的合法性
 */
function validateMessageSequence(message: any, previousMessage?: any): boolean {
  // 基本字段
  if (!message || typeof message.role !== 'string') return false;

  // 允许两种有效形态：
  // 1) content 存在（字符串/数组/对象）
  // 2) reasoning-only 输出
  // 3) 仅工具调用（content 为空，但存在 tool_calls[] 且 finish_reason=tool_calls）
  const hasContent = hasMeaningfulContent((message as any).content);
  const hasReasoning =
    (typeof (message as any).reasoning_content === 'string' && (message as any).reasoning_content.trim().length > 0)
    || (typeof (message as any).reasoning === 'string' && (message as any).reasoning.trim().length > 0);
  const hasToolCalls = Array.isArray((message as any).tool_calls) && (message as any).tool_calls.length > 0;
  if (!hasContent && !hasReasoning && !hasToolCalls) return false;

  // 不允许 assistant 之后出现 user 倒序
  if (previousMessage?.role === 'assistant' && message.role === 'user') return false;

  return true;
}

function hasMeaningfulContent(content: any): boolean {
  if (content == null) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  if (typeof content === 'object') return Object.keys(content).length > 0;
  return false;
}

function appendReasoningToContent(message: any, reasoningText: string, prefix?: string): void {
  const trimmed = reasoningText.trim();
  if (!trimmed) {
    return;
  }
  const normalizedPrefix = typeof prefix === 'string' && prefix.length ? prefix : '';
  const formatted = normalizedPrefix ? `${normalizedPrefix}${normalizedPrefix.endsWith(' ') || normalizedPrefix.endsWith('\n') ? '' : ' '}${trimmed}` : trimmed;
  const current = (message as any).content;
  if (typeof current === 'string' || current == null) {
    (message as any).content = typeof current === 'string' && current.length
      ? `${current}${current.endsWith('\n') ? '' : '\n\n'}${formatted}`
      : formatted;
    return;
  }
  if (Array.isArray(current)) {
    current.push({ type: 'text', text: formatted });
    return;
  }
  (message as any).content = [current, { type: 'text', text: formatted }];
}

/**
 * 异步生成器：为事件添加序列号和延迟
 */
async function* withSequencing(
  events: Generator<ChatSseEvent> | AsyncGenerator<ChatSseEvent> | ChatSseEvent[],
  config: ChatSequencerConfig,
  startSequence: number = 0
): AsyncGenerator<ChatSseEvent> {
  let sequenceNumber = startSequence;

  for await (const event of events) {
    if (config.includeSequenceNumbers) (event as any).sequenceNumber = sequenceNumber++;

    yield event;

    if (config.enableDelay && config.chunkDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs));
    }
  }
}

/**
 * 序列化单个消息的内容和工具调用
 */
async function* sequenceMessageContent(
  message: any,
  context: ChatEventGeneratorContext,
  config: ChatSequencerConfig
): AsyncGenerator<ChatSseEvent> {
  // 1. 发送role delta
  for (const roleEvent of buildRoleDelta(message.role, context, config)) {
    yield roleEvent;
  }

  const contentNormalization = normalizeChatMessageContent((message as any).content);
  if (contentNormalization.contentText !== undefined) {
    (message as any).content = contentNormalization.contentText;
  }

  const normalization = normalizeMessageReasoningTools(message, {
    idPrefix: `chat_seq_reasoning_${context.choiceIndex + 1}`
  });
  const reasoningText = normalization.cleanedReasoning
    ?? contentNormalization.reasoningText
    ?? (typeof (message as any)?.reasoning_content === 'string'
      ? (message as any).reasoning_content
      : typeof (message as any)?.reasoning === 'string'
        ? (message as any).reasoning
        : undefined);
  const reasoningDispatch = dispatchReasoning(reasoningText, {
    mode: config.reasoningMode,
    prefix: config.reasoningTextPrefix
  });
  if (reasoningDispatch.appendToContent) {
    appendReasoningToContent(message, reasoningDispatch.appendToContent);
  }
  const reasoningForChannel = reasoningDispatch.channel;

  // 2. 处理reasoning（如果有）
  if (reasoningForChannel) {
    yield* withSequencing(
      buildReasoningDeltas(reasoningForChannel, context, config),
      config
    );
  }

  // 3. 处理content和tool_calls
  if (hasMeaningfulContent(message.content)) {
    yield* withSequencing(
      buildContentDeltas(message.content, context, config),
      config
    );
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const toolCall = message.tool_calls[i];
      const toolCallIndex = context.toolCallIndexCounter + i;

      yield buildToolCallStart(toolCall, toolCallIndex, context, config);

      if (toolCall.function?.arguments) {
        yield* withSequencing(
          buildToolCallArgsDeltas(toolCall.function.arguments, toolCallIndex, context, config),
          config
        );
      }
    }
  }
}

/**
 * 主编排器：将Chat响应转换为有序的SSE事件流
 */
export async function* sequenceChatResponse(
  response: ChatCompletionResponse,
  context: ChatEventGeneratorContext,
  config: ChatSequencerConfig = DEFAULT_CHAT_SEQUENCER_CONFIG
): AsyncGenerator<ChatSseEvent> {
  try {
    // 验证响应格式
    if (!response.choices || response.choices.length === 0) {
      throw new Error('Invalid ChatCompletionResponse: missing choices');
    }

    const choice = response.choices[0] as any;
    let message = choice?.message;
    // 兼容上游给到的 chunk 形态（choices[0].delta）
    if (!message && choice && typeof choice === 'object' && choice.delta) {
      const d = choice.delta;
      message = {
        role: typeof d.role === 'string' ? d.role : 'assistant',
        content: typeof d.content !== 'undefined' ? d.content : null,
        tool_calls: Array.isArray(d.tool_calls) ? d.tool_calls : undefined
      };
      // 为了下游 finish 事件合理性，缺省 finish_reason：若存在工具调用则用 tool_calls，否则 stop
      if (!('finish_reason' in choice)) {
        (choice as any).finish_reason = message.tool_calls ? 'tool_calls' : 'stop';
      }
    }

    message = normalizeFunctionCall(message);

    // 验证消息顺序（如果启用）
    if (config.validateOrder) {
      // 这里可以添加更多的顺序验证逻辑
      if (!validateMessageSequence(message)) {
        const roleSafe = message && typeof (message as any).role === 'string' ? (message as any).role : 'unknown';
        throw new Error(`Invalid message sequence for role: ${roleSafe}`);
      }
    }

    // 序列化消息内容
    yield* sequenceMessageContent(message, context, config);

    // 发送finish_reason事件（若未提供则根据消息推断）
    yield buildFinishEvent(
      (choice as any).finish_reason || (message?.tool_calls ? 'tool_calls' : 'stop'),
      context,
      config,
      response.usage
    );

    // 发送done事件
    yield buildDoneEvent(context, config);

  } catch (error) {
    // 发送错误事件
    yield buildErrorEvent(error as Error, context, config);
  }
}

function normalizeFunctionCall(message: any): any {
  if (!message || typeof message !== 'object') return message;
  if ((message.tool_calls && message.tool_calls.length) || !message.function_call) {
    return message;
  }
  const fc = message.function_call;
  const name = typeof fc?.name === 'string' ? fc.name : 'function';
  let args: string = '';
  if (typeof fc?.arguments === 'string') {
    args = fc.arguments;
  } else {
    try { args = JSON.stringify(fc?.arguments ?? {}); } catch { args = '{}'; }
  }
  message.tool_calls = [
    {
      id: typeof fc?.id === 'string' ? fc.id : `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name, arguments: args }
    }
  ];
  return message;
}

/**
 * 序列化Chat请求（用于请求→SSE转换）
 */
export async function* sequenceChatRequest(
  request: any,
  context: ChatEventGeneratorContext,
  config: ChatSequencerConfig = DEFAULT_CHAT_SEQUENCER_CONFIG
): AsyncGenerator<ChatSseEvent> {
  try {
    // 验证请求格式
    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error('Invalid ChatCompletionRequest: missing messages');
    }

    // 为每个消息生成事件（主要用于流式回显）
    for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex++) {
      const message = request.messages[messageIndex];

      // 为每条消息创建新的上下文
      const messageContext = {
        ...context,
        choiceIndex: messageIndex,
        toolCallIndexCounter: 0,
        contentIndexCounter: new Map()
      };

      // 序列化消息
      yield* sequenceMessageContent(message, messageContext, config);

      // 消息间添加小延迟（如果启用）
      if (config.enableDelay && config.chunkDelayMs > 0 && messageIndex < request.messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs * 2));
      }
    }

    // 请求结束时发送done事件
    yield buildDoneEvent(context, config);

  } catch (error) {
    yield buildErrorEvent(error as Error, context, config);
  }
}

/**
 * 创建Chat事件序列化器工厂
 */
export function createChatSequencer(config?: Partial<ChatSequencerConfig>) {
  const finalConfig = { ...DEFAULT_CHAT_SEQUENCER_CONFIG, ...config };

  return {
    /**
     * 序列化响应
     */
    async *sequenceResponse(response: ChatCompletionResponse, model: string, requestId: string) {
      const context = createDefaultContext(model, requestId);
      yield* sequenceChatResponse(response, context, finalConfig);
    },

    /**
     * 序列化请求
     */
    async *sequenceRequest(request: any, model: string, requestId: string) {
      const context = createDefaultContext(model, requestId);
      yield* sequenceChatRequest(request, context, finalConfig);
    },

    /**
     * 获取当前配置
     */
    getConfig(): ChatSequencerConfig {
      return { ...finalConfig };
    }
  };
}
