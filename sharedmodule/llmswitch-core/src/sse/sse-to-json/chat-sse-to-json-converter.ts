/**
 * Chat SSE → JSON转换器
 * 将SSE事件流聚合为ChatCompletion响应
 */

import { DEFAULT_CHAT_CONVERSION_CONFIG, CHAT_CONVERSION_ERROR_CODES } from '../types/index.js';
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatSseEvent,
  ChatSseEventType,
  SseToChatJsonContext,
  SseToChatJsonOptions,
  ChatEventStats,
  ChatChoiceBuilder,
  ChatToolCallChunk,
  ChatMessage,
  ChatToolCall
} from '../types/index.js';
import {
  TimeUtils,
  ErrorUtils
} from '../shared/utils.js';
import { normalizeMessageReasoningTools } from '../../conversion/shared/reasoning-tool-normalizer.js';
import { normalizeChatMessageContent } from '../../conversion/shared/chat-output-normalizer.js';
import { dispatchReasoning } from '../shared/reasoning-dispatcher.js';

/**
 * Chat SSE到JSON转换器
 */
export class ChatSseToJsonConverter {
  private config = DEFAULT_CHAT_CONVERSION_CONFIG;
  private contexts = new Map<string, SseToChatJsonContext>();

  constructor(config?: Partial<typeof DEFAULT_CHAT_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * 将SSE流转换为Chat Completion响应
   */
  async convertSseToJson(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): Promise<ChatCompletionResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      // 处理SSE流
      for await (const event of this.ensureEventStream(sseStream)) {
        await this.processSseEvent(event, context);
      }

      // 验证并返回最终响应
      return this.finalizeResponse(context);

    } catch (error) {
      context.eventStats.errorCount++;
      options.onError?.(error as Error);
      throw ErrorUtils.wrapError(error, 'SSE to JSON conversion failed');
    } finally {
      this.cleanup(options.requestId);
    }
  }

  /**
   * 将SSE流转换为流式响应
   */
  async *aggregateSseStream(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): AsyncGenerator<ChatCompletionResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      for await (const event of this.ensureEventStream(sseStream)) {
        await this.processSseEvent(event, context);

        // 每处理完一个chunk就生成部分响应
        const partialResponse = this.buildPartialResponse(context);
        if (partialResponse) {
          options.onPartialResponse?.(partialResponse);
          yield partialResponse;
        }
      }

      // 返回最终响应
      const finalResponse = this.finalizeResponse(context);
      options.onCompletion?.(finalResponse);
      yield finalResponse;

    } catch (error) {
      context.eventStats.errorCount++;
      options.onError?.(error as Error);
      throw ErrorUtils.wrapError(error, 'SSE stream aggregation failed');
    } finally {
      this.cleanup(options.requestId);
    }
  }

  /**
   * 确保输入流转换为 ChatSseEvent 流
   */
  private async *ensureEventStream(
    source: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>
  ): AsyncGenerator<ChatSseEvent> {
    let textBuffer = '';

    for await (const chunk of source) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const normalizedChunk = (typeof chunk === 'string' ? chunk : chunk.toString())
          .replace(/\r\n/g, '\n');
        textBuffer += normalizedChunk;

        let delimiterIndex = textBuffer.indexOf('\n\n');
        while (delimiterIndex !== -1) {
          const rawEvent = textBuffer.slice(0, delimiterIndex);
          textBuffer = textBuffer.slice(delimiterIndex + 2);
          const trimmed = rawEvent.trim();
          if (trimmed) {
            yield this.parseSseChunk(trimmed);
          }
          delimiterIndex = textBuffer.indexOf('\n\n');
        }
      } else if ((chunk as ChatSseEvent)?.event) {
        yield chunk as ChatSseEvent;
      } else {
        throw ErrorUtils.createError(
          'Unsupported SSE chunk format',
          CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
          { chunk }
        );
      }
    }

    const trailing = textBuffer.trim();
    if (trailing) {
      yield this.parseSseChunk(trailing);
    }
  }

  /**
   * 将SSE文本块解析为Chat事件
   */
  private parseSseChunk(chunk: string): ChatSseEvent {
    const lines = chunk.trim().split('\n');
    let rawEventType: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        rawEventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.substring(5).trim());
      }
    }
    const dataValue = dataLines.join('\n');
    const parsedData = (() => {
      if (!dataValue) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(dataValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // best effort
      }
      return undefined;
    })();

    const normalizeEventType = (
      candidate: string | undefined,
      payload?: Record<string, unknown>
    ): ChatSseEventType | undefined => {
      if (!candidate) return undefined;
      const v = candidate.trim().toLowerCase();
      if (!v) return undefined;
      // OpenAI Chat Completions SSE does not include `event:` lines; we infer types elsewhere.
      // When upstream does include `event:`, accept common aliases for compatibility.
      if (v === 'chat_chunk') return 'chat_chunk';
      if (v === 'chat.done' || v === 'chat_done') return 'chat.done';
      if (v === 'ping' || v === 'heartbeat') return 'ping';
      if (v === 'error') return 'error';
      // DeepSeek-web style control events (non-content).
      if (v === 'ready' || v === 'update_session' || v === 'title') return 'ping';
      if (v === 'finish' || v === 'close') return 'chat.done';
      if (v === 'toast') {
        const toastType = typeof payload?.type === 'string' ? payload.type.trim().toLowerCase() : '';
        const finishReason = typeof payload?.finish_reason === 'string'
          ? payload.finish_reason.trim().toLowerCase()
          : '';
        if (toastType === 'error' || finishReason === 'context_length_exceeded' || finishReason === 'rate_limit_exceeded') {
          return 'error';
        }
        return 'ping';
      }
      // Legacy aliases
      if (v === 'chunk') return 'chat_chunk';
      if (v === 'done') return 'chat.done';
      return undefined;
    };

    let eventType = normalizeEventType(rawEventType, parsedData);
    if (!eventType) {
      // OpenAI-compatible streams often omit `event:`; use `[DONE]` sentinel to mark completion.
      if (dataValue) {
        eventType = dataValue === '[DONE]' ? 'chat.done' : 'chat_chunk';
      }
    }

    if (!eventType) {
      throw ErrorUtils.createError(
        'SSE event type is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { chunk }
      );
    }

    return {
      event: eventType,
      type: eventType,
      timestamp: TimeUtils.now(),
      data: dataValue,
      protocol: 'chat',
      direction: 'sse_to_json'
    };
  }

  /**
   * 创建转换上下文
   */
  private createContext(options: SseToChatJsonOptions): SseToChatJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options: { ...DEFAULT_CHAT_CONVERSION_CONFIG, ...options },
      startTime: TimeUtils.now(),
      aggregatedChunks: [],
      currentResponse: {
        id: '',
        object: 'chat.completion',
        created: 0,
        model: options.model,
        choices: []
      },
      choiceIndexMap: new Map(),
      toolCallIndexMap: new Map(),
      eventStats: {
        totalChunks: 0,
        totalTokens: 0,
        totalChoices: 0,
        totalToolCalls: 0,
        startTime: TimeUtils.now(),
        tokenRate: 0,
        chunkRate: 0,
        errorCount: 0,
        retryCount: 0
      },
      isCompleted: false
    };
  }

  /**
   * 处理SSE事件
   */
  private async processSseEvent(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    try {
      // 验证事件格式
      if (context.options.validateChunks) {
        this.validateSseEvent(event);
      }

      context.eventStats.totalChunks++;
      context.options.onEvent?.(event);

      switch (event.event) {
        case 'chat_chunk':
          await this.processChatChunk(event, context);
          break;

        case 'chat.done':
          await this.processDoneEvent(event, context);
          break;

        case 'error':
          await this.processErrorEvent(event, context);
          break;

        case 'ping':
          // 心跳事件，忽略处理
          break;

        default:
          throw ErrorUtils.createError(
            `Unknown SSE event type: ${event.event}`,
            CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
            { event }
          );
      }

      // 更新统计
      this.updateStats(context);

    } catch (error) {
      context.eventStats.errorCount++;
      throw ErrorUtils.wrapError(error, `Failed to process SSE event: ${event.event}`);
    }
  }

  /**
   * 处理chat_chunk事件
   */
  private async processChatChunk(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    try {
      const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {});
      const parsedEntries = this.parseChatChunkPayload(payload);

      for (const parsed of parsedEntries) {
        if (this.tryProcessDeepSeekWebPatchEvent(parsed, context)) {
          continue;
        }

        const chunk = parsed as ChatCompletionChunk;

        // 验证chunk格式
        if (context.options.validateChunks) {
          this.validateChatChunk(chunk);
        }

        context.aggregatedChunks.push(chunk);

        // 初始化响应结构（如果是第一个chunk）
        if (!context.currentResponse.id && chunk.id) {
          context.currentResponse.id = chunk.id;
          context.currentResponse.object = 'chat.completion';
          context.currentResponse.created = chunk.created;
          context.currentResponse.model = chunk.model;
        }

        // 处理choices
        if (chunk.choices && Array.isArray(chunk.choices)) {
          for (const choice of chunk.choices) {
            await this.processChoice(choice, context);
          }
        }
      }
    } catch (error) {
      throw ErrorUtils.wrapError(error, 'Failed to parse chat_chunk');
    }
  }

  private parseChatChunkPayload(payload: string): unknown[] {
    try {
      return [JSON.parse(payload) as unknown];
    } catch (primaryError) {
      const segments = payload
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (segments.length <= 1) {
        throw primaryError;
      }

      const parsed: unknown[] = [];
      for (const segment of segments) {
        try {
          parsed.push(JSON.parse(segment) as unknown);
        } catch {
          // Ignore non-JSON lines so valid partial frames can still be recovered.
        }
      }
      if (!parsed.length) {
        throw primaryError;
      }
      return parsed;
    }
  }

  private ensureChoiceBuilder(
    context: SseToChatJsonContext,
    choiceIndex: number
  ): ChatChoiceBuilder {
    let choiceBuilder = context.choiceIndexMap.get(choiceIndex);
    if (!choiceBuilder) {
      choiceBuilder = this.createChoiceBuilder(choiceIndex);
      context.choiceIndexMap.set(choiceIndex, choiceBuilder);
      context.currentResponse.choices?.push({
        index: choiceIndex,
        message: {
          role: 'assistant',
          content: ''
        },
        finish_reason: 'stop'
      });
    }
    return choiceBuilder;
  }

  private tryProcessDeepSeekWebPatchEvent(
    parsed: unknown,
    context: SseToChatJsonContext
  ): boolean {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const payload = parsed as Record<string, unknown>;

    // Standard OpenAI chunk path should continue with default processing.
    if (Array.isArray(payload.choices) || payload.object === 'chat.completion.chunk') {
      return false;
    }

    const path = typeof payload.p === 'string' ? payload.p : '';
    const op = typeof payload.o === 'string' ? payload.o : '';
    const value = payload.v;
    const deepseekState = this.getDeepSeekPatchState(context);
    const isBareContinuation = deepseekState.patchAppendActive && !path && typeof value === 'string';
    const looksLikeDeepSeekPatch =
      path.startsWith('response/')
      || typeof payload.request_message_id === 'number'
      || typeof payload.response_message_id === 'number'
      || typeof payload.updated_at === 'number'
      || (value !== null && typeof value === 'object' && !Array.isArray(value))
      || isBareContinuation;

    if (!looksLikeDeepSeekPatch) {
      return false;
    }

    if (!context.currentResponse.id) {
      context.currentResponse.id = `chat_${context.requestId}`;
    }
    if (!context.currentResponse.object) {
      context.currentResponse.object = 'chat.completion';
    }
    if (!context.currentResponse.created) {
      context.currentResponse.created = Math.floor(Date.now() / 1000);
    }
    if (!context.currentResponse.model) {
      context.currentResponse.model = context.model;
    }

    const choiceBuilder = this.ensureChoiceBuilder(context, 0);
    choiceBuilder.messageBuilder.role = choiceBuilder.messageBuilder.role || 'assistant';

    if (path === 'response/content' && op === 'APPEND' && typeof value === 'string') {
      deepseekState.patchAppendActive = true;
      choiceBuilder.messageBuilder.content = (choiceBuilder.messageBuilder.content || '') + value;
      choiceBuilder.accumulatedContent += value;
    } else if (!path && typeof value === 'string' && value.length > 0) {
      // DeepSeek sometimes continues APPEND content via bare {"v":"..."} frames.
      choiceBuilder.messageBuilder.content = (choiceBuilder.messageBuilder.content || '') + value;
      choiceBuilder.accumulatedContent += value;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const responseNode = inner.response;
      if (responseNode && typeof responseNode === 'object' && !Array.isArray(responseNode)) {
        const responseRecord = responseNode as Record<string, unknown>;
        if (typeof responseRecord.content === 'string' && responseRecord.content.length > 0) {
          choiceBuilder.messageBuilder.content =
            (choiceBuilder.messageBuilder.content || '') + responseRecord.content;
          choiceBuilder.accumulatedContent += responseRecord.content;
        }
        if (typeof responseRecord.status === 'string' && responseRecord.status.toUpperCase() === 'FINISHED') {
          choiceBuilder.finishReason = 'stop';
          choiceBuilder.isCompleted = true;
        }
      }
    }

    if (path === 'response/accumulated_token_usage' && typeof value === 'number') {
      context.eventStats.totalTokens = value;
    }
    if (path === 'response/status' && typeof value === 'string' && value.toUpperCase() === 'FINISHED') {
      deepseekState.patchAppendActive = false;
      choiceBuilder.finishReason = 'stop';
      choiceBuilder.isCompleted = true;
      context.isCompleted = true;
    }

    this.updateResponseChoice(0, choiceBuilder, context);
    return true;
  }

  private getDeepSeekPatchState(
    context: SseToChatJsonContext
  ): { patchAppendActive: boolean } {
    const carrier = context as SseToChatJsonContext & {
      deepseekPatchState?: { patchAppendActive?: boolean };
    };
    if (!carrier.deepseekPatchState) {
      carrier.deepseekPatchState = { patchAppendActive: false };
    }
    return {
      get patchAppendActive() {
        return Boolean(carrier.deepseekPatchState?.patchAppendActive);
      },
      set patchAppendActive(value: boolean) {
        if (!carrier.deepseekPatchState) {
          carrier.deepseekPatchState = {};
        }
        carrier.deepseekPatchState.patchAppendActive = value;
      }
    };
  }

  /**
   * 处理choice
   */
  private async processChoice(
    choice: ChatCompletionChunk['choices'][number],
    context: SseToChatJsonContext
  ): Promise<void> {
    const choiceIndex = choice.index || 0;

    // 获取或创建choice构建器
    let choiceBuilder = context.choiceIndexMap.get(choiceIndex);
    if (!choiceBuilder) {
      choiceBuilder = this.createChoiceBuilder(choiceIndex);
      context.choiceIndexMap.set(choiceIndex, choiceBuilder);
      context.currentResponse.choices?.push({
        index: choiceIndex,
        message: {
          role: 'assistant',
          content: ''
        },
        finish_reason: 'stop',
        logprobs: choice.logprobs
      });
    }

    // 处理delta
    if (choice.delta) {
      await this.processDelta(choice.delta, choiceBuilder, context);
    }

    // 处理finish_reason
    if (choice.finish_reason) {
      choiceBuilder.finishReason = choice.finish_reason;
      choiceBuilder.isCompleted = true;
    }

    // 更新响应中的choice
    this.updateResponseChoice(choiceIndex, choiceBuilder, context);
  }

  /**
   * 创建choice构建器
   */
  private createChoiceBuilder(index: number): ChatChoiceBuilder {
    return {
      index,
      delta: {},
      finishReason: undefined,
      logprobs: undefined,
      messageBuilder: {
        role: undefined,
        content: '',
        reasoningContent: '',
        name: undefined,
        functionCall: undefined,
        toolCalls: [],
        toolCallId: undefined,
        isCompleted: false
      },
      isCompleted: false,
      accumulatedContent: '',
      toolCallBuilders: new Map()
    };
  }

  /**
   * 将reasoning文本附加到消息内容
   */
  private appendReasoningToMessageContent(message: ChatMessage, reasoningText: string): void {
    const trimmed = typeof reasoningText === 'string' ? reasoningText.trim() : '';
    if (!trimmed) {
      return;
    }
    const current = typeof message.content === 'string' ? message.content : '';
    const needsSeparator = current.length > 0;
    const separator = !needsSeparator ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    message.content = `${current}${separator}${trimmed}`;
  }

  /**
   * 处理delta
   */
  private async processDelta(
    delta: NonNullable<ChatCompletionChunk['choices'][number]['delta']>,
    choiceBuilder: ChatChoiceBuilder,
    _context: SseToChatJsonContext
  ): Promise<void> {
    const messageBuilder = choiceBuilder.messageBuilder;

    // 处理role
    if (delta.role) {
      messageBuilder.role = delta.role;
    }

    // 处理reasoning
    if (delta.reasoning) {
      const chunk = delta.reasoning;
      messageBuilder.reasoningContent = (messageBuilder.reasoningContent || '') + chunk;
      choiceBuilder.accumulatedContent += chunk;
    }

    // 处理content
    if (delta.content) {
      messageBuilder.content += delta.content;
      choiceBuilder.accumulatedContent += delta.content;
    }

    // 处理function_call
    if (delta.function_call) {
      if (delta.function_call.name) {
        messageBuilder.functionCall = {
          ...messageBuilder.functionCall,
          name: delta.function_call.name
        };
      }
      if (delta.function_call.arguments) {
        messageBuilder.functionCall = {
          ...messageBuilder.functionCall,
          arguments: (messageBuilder.functionCall?.arguments || '') + delta.function_call.arguments
        };
      }
    }

    // 处理tool_calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        await this.processToolCallDelta(toolCallDelta, choiceBuilder);
      }
    }

    // 合并delta到choiceBuilder
    choiceBuilder.delta = { ...choiceBuilder.delta, ...delta };
  }

  /**
   * 处理tool_call delta
   */
  private async processToolCallDelta(
    toolCallDelta: ChatToolCallChunk,
    choiceBuilder: ChatChoiceBuilder
  ): Promise<void> {
    const toolCallIndex = toolCallDelta.index;

    // 获取或创建tool_call构建器
    let toolCallBuilder = choiceBuilder.toolCallBuilders.get(toolCallIndex);
    if (!toolCallBuilder) {
      toolCallBuilder = {
        index: toolCallIndex,
        id: '',
        type: 'function',
        function: {
          name: '',
          arguments: ''
        },
        isCompleted: false,
        accumulatedArguments: ''
      };
      choiceBuilder.toolCallBuilders.set(toolCallIndex, toolCallBuilder);
    }

    // 更新tool_call构建器
    if (toolCallDelta.id) {
      toolCallBuilder.id = toolCallDelta.id;
    }

    if (toolCallDelta.type) {
      toolCallBuilder.type = toolCallDelta.type;
    }

    if (toolCallDelta.function) {
      if (toolCallDelta.function.name) {
        toolCallBuilder.function!.name = toolCallDelta.function.name;
      }
      if (toolCallDelta.function.arguments) {
        toolCallBuilder.function!.arguments += toolCallDelta.function.arguments;
        toolCallBuilder.accumulatedArguments += toolCallDelta.function.arguments;
      }
    }

    // 标记完成（当arguments不为空且id存在时）
    if (toolCallBuilder.id && toolCallBuilder.function!.arguments) {
      toolCallBuilder.isCompleted = true;
    }
  }

  /**
   * 更新响应中的choice
   */
  private updateResponseChoice(
    choiceIndex: number,
    choiceBuilder: ChatChoiceBuilder,
    context: SseToChatJsonContext
  ): void {
    const responseChoice = context.currentResponse.choices?.[choiceIndex];
    if (!responseChoice) {
      return;
    }

    const messageBuilder = choiceBuilder.messageBuilder;

    // 构建message
    const message: ChatMessage = {
      role: messageBuilder.role || 'assistant'
    };

    const normalizedContent = normalizeChatMessageContent(messageBuilder.content);
    if (normalizedContent.contentText !== undefined) {
      message.content = normalizedContent.contentText;
    } else if (messageBuilder.content) {
      message.content = messageBuilder.content;
    }
    const reasoningCandidate =
      messageBuilder.reasoningContent && messageBuilder.reasoningContent.length
        ? messageBuilder.reasoningContent
        : normalizedContent.reasoningText;
    if (reasoningCandidate) {
      (message as any).reasoning_content = reasoningCandidate;
    }

    if (messageBuilder.functionCall) {
      message.function_call = messageBuilder.functionCall;
    }

    // 构建tool_calls
    const toolCalls: ChatToolCall[] = [];
    for (const toolCallBuilder of choiceBuilder.toolCallBuilders.values()) {
      if (toolCallBuilder.id && toolCallBuilder.function) {
        toolCalls.push({
          id: toolCallBuilder.id,
          type: toolCallBuilder.type || 'function',
          function: {
            name: toolCallBuilder.function.name ?? '',
            arguments: toolCallBuilder.function.arguments ?? ''
          }
        });
      }
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    this.normalizeReasoning(choiceBuilder, message, context);

    responseChoice.message = message;
    responseChoice.finish_reason = choiceBuilder.finishReason ?? responseChoice.finish_reason;

    context.eventStats.totalToolCalls += toolCalls.length;
  }

  /**
   * 将reasoning内容规范化为独立字段并抽取工具调用
   */
  private normalizeReasoning(
    choiceBuilder: ChatChoiceBuilder,
    message: ChatMessage,
    context: SseToChatJsonContext
  ): void {
    if (!(message as any).reasoning_content && !(message as any).reasoning) {
      return;
    }

    const target = message as unknown as Record<string, unknown>;
    normalizeMessageReasoningTools(target, {
      idPrefix: `chat_sse_reasoning_${choiceBuilder.index + 1}`
    });

    const reasoningSource =
      typeof (target as any).reasoning_content === 'string'
        ? (target as any).reasoning_content
        : typeof (target as any).reasoning === 'string'
          ? (target as any).reasoning
          : undefined;

    const reasoningText = typeof reasoningSource === 'string' ? reasoningSource.trim() : '';
    if (!reasoningText) {
      if ('reasoning_content' in target) delete (target as any).reasoning_content;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    const dispatchResult = dispatchReasoning(reasoningText, {
      mode: context.options.reasoningMode ?? this.config.reasoningMode,
      prefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
    });

    if (dispatchResult.appendToContent) {
      this.appendReasoningToMessageContent(message, dispatchResult.appendToContent);
      if ('reasoning_content' in target) delete (target as any).reasoning_content;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    if (dispatchResult.channel) {
      (target as any).reasoning_content = dispatchResult.channel;
      if ('reasoning' in target) delete (target as any).reasoning;
      return;
    }

    if ('reasoning_content' in target) delete (target as any).reasoning_content;
    if ('reasoning' in target) delete (target as any).reasoning;
  }

  /**
   * 处理done事件
   */
  private async processDoneEvent(
    event: ChatSseEvent,
    context: SseToChatJsonContext
  ): Promise<void> {
    context.isCompleted = true;

    // 解析done事件数据（如果有的话）
    try {
      if (typeof event.data === 'string') {
        const doneData = JSON.parse(event.data) as { totalTokens?: number };
        if (typeof doneData.totalTokens === 'number') {
          context.eventStats.totalTokens = doneData.totalTokens;
        }
      }
    } catch (e) {
      // 忽略解析错误
    }
  }

  /**
   * 处理error事件
   */
  private async processErrorEvent(
    event: ChatSseEvent,
    _context: SseToChatJsonContext
  ): Promise<void> {
    const rawPayload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {});
    let errorData: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        errorData = parsed as Record<string, unknown>;
      }
    } catch {
      // keep raw payload only
    }

    const errorMessage = errorData
      ? (typeof errorData.error === 'string'
          ? errorData.error
          : typeof errorData.message === 'string'
            ? errorData.message
            : typeof errorData.content === 'string'
              ? errorData.content
              : 'Unknown SSE error')
      : `SSE error event: ${event.data}`;
    const code = errorData
      ? (typeof errorData.code === 'string'
          ? errorData.code
          : typeof errorData.finish_reason === 'string'
            ? errorData.finish_reason
            : 'SSE_ERROR')
      : 'SSE_ERROR';
    const typedError = new Error(errorMessage) as Error & { code?: string };
    typedError.code = code;

    throw ErrorUtils.createError(
      typedError.message,
      CHAT_CONVERSION_ERROR_CODES.STREAM_ERROR,
      { errorData, event }
    );
  }

  /**
   * 构建部分响应
   */
  private buildPartialResponse(context: SseToChatJsonContext): ChatCompletionResponse | null {
    const choices = context.currentResponse.choices || [];
    if (choices.length === 0) {
      return null;
    }

    return {
      id: context.currentResponse.id || '',
      object: 'chat.completion',
      created: context.currentResponse.created || 0,
      model: context.currentResponse.model,
      choices: choices.map(choice => ({
        ...choice,
        // 确保message对象存在
        message: choice.message || { role: 'assistant', content: '' }
      }))
    };
  }

  /**
   * 完成响应构建
   */
  private finalizeResponse(context: SseToChatJsonContext): ChatCompletionResponse {
    const choices = context.currentResponse.choices || [];

    // 确保所有choices都已完成
    for (const choice of choices) {
      if (!choice.finish_reason) {
        choice.finish_reason = 'stop';
      }
    }

    // 构建usage信息
    const usage = this.buildUsageInfo(context);

    context.eventStats.totalChoices = choices.length;
    context.eventStats.endTime = TimeUtils.now();
    context.eventStats.duration = (context.eventStats.endTime - context.eventStats.startTime) / 1000;

    return {
      id: context.currentResponse.id || `chat_${context.requestId}`,
      object: 'chat.completion',
      created: context.currentResponse.created || Math.floor(Date.now() / 1000),
      model: context.currentResponse.model,
      choices,
      usage: usage || undefined
    };
  }

  /**
   * 构建使用量信息
   */
  private buildUsageInfo(_context: SseToChatJsonContext): ChatCompletionResponse['usage'] | null {
    // 这里可以基于token计数来计算usage
    // 暂时返回null，后续可以实现更精确的token计数
    return null;
  }

  /**
   * 验证SSE事件
   */
  private validateSseEvent(event: ChatSseEvent): void {
    if (!event.event) {
      throw ErrorUtils.createError(
        'SSE event type is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }

    if (!event.data) {
      throw ErrorUtils.createError(
        'SSE event data is required',
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }

    const validEvents: ChatSseEventType[] = ['chat_chunk', 'chat.done', 'error', 'ping'];
    if (!validEvents.includes(event.event as ChatSseEventType)) {
      throw ErrorUtils.createError(
        `Invalid SSE event type: ${event.event}`,
        CHAT_CONVERSION_ERROR_CODES.VALIDATION_ERROR,
        { event }
      );
    }
  }

  /**
   * 验证Chat chunk
   */
  private validateChatChunk(chunk: ChatCompletionChunk): void {
    if (!chunk.object || chunk.object !== 'chat.completion.chunk') {
      throw ErrorUtils.createError(
        'Invalid chat completion chunk object',
        CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
        { chunk }
      );
    }

    if (!Array.isArray(chunk.choices)) {
      throw ErrorUtils.createError(
        'Chunk choices must be an array',
        CHAT_CONVERSION_ERROR_CODES.PARSE_ERROR,
        { chunk }
      );
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(context: SseToChatJsonContext): void {
    const now = TimeUtils.now();
    const duration = (now - context.eventStats.startTime) / 1000;

    context.eventStats.duration = duration;
    context.eventStats.chunkRate = context.eventStats.totalChunks / duration;
    context.eventStats.tokenRate = context.eventStats.totalTokens / duration;
  }

  /**
   * 获取转换统计
   */
  getStats(requestId: string): ChatEventStats | undefined {
    const context = this.contexts.get(requestId);
    return context?.eventStats;
  }

  /**
   * 清理上下文
   */
  cleanup(requestId: string): void {
    this.contexts.delete(requestId);
  }

  /**
   * 清理所有上下文
   */
  cleanupAll(): void {
    this.contexts.clear();
  }
}

// 创建默认转换器实例
export const defaultChatSseToJsonConverter = new ChatSseToJsonConverter();
