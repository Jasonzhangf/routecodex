/**
 * Chat JSON → SSE转换器（重构版本）
 * 使用函数化架构：事件生成 + 序列化 + 写入分离
 */

// feature_id: sse.chat_stream_projection
import { PassThrough } from 'stream';
import { DEFAULT_CHAT_CONVERSION_CONFIG } from '../types/index.js';
import type {
  ChatCompletionResponse,
  ChatSseEvent,
  ChatJsonToSseContext,
  ChatJsonToSseOptions,
  ChatEventStats,
  ChatSseEventStream
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createChatSequencer } from './sequencers/chat-sequencer.js';
import { createChatStreamWriter } from '../shared/writer.js';

/**
 * 重构后的Chat JSON到SSE转换器
 * 采用函数化架构，专注于编排而非具体业务逻辑
 */
export class ChatJsonToSseConverterRefactored {
  private config = DEFAULT_CHAT_CONVERSION_CONFIG;

  constructor(config?: Partial<typeof DEFAULT_CHAT_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * 将Chat Completion响应转换为SSE流
   */
  async convertResponseToJsonToSse(
    response: ChatCompletionResponse,
    options: ChatJsonToSseOptions
  ): Promise<ChatSseEventStream> {
    try {
      this.validateResponse(response);
    } catch (error) {
      throw this.wrapError('RESPONSE_CONVERSION_ERROR', error as Error, options.requestId);
    }
    // 1. 创建上下文
    const context = this.createResponseContext(response, options);

    // 2. 创建底层流
    const stream = new PassThrough({ objectMode: true });

    // 3. 创建SSE事件流接口
    const sseStream: ChatSseEventStream = Object.assign(stream, {
      protocol: 'chat' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => context.eventStats,
      getConfig: () => this.config,
      complete: () => this.completeStream(context, stream),
      abort: (error?: Error) => this.abortStream(context, stream, error)
    }) as ChatSseEventStream;

    // 4. 启动异步转换过程（使用函数化架构）
    this.processResponseToSseWithFunctions(response, context, stream).catch(error => {
      this.handleStreamError(context, error, stream);
    });

    return sseStream;
  }

  /**
   * 使用函数化架构处理响应转换
   */
  private async processResponseToSseWithFunctions(
    response: ChatCompletionResponse,
    context: ChatJsonToSseContext,
    stream: PassThrough
  ): Promise<void> {
    try {
      // 1. 验证响应
      this.validateResponse(response);

      // 2. 创建流写入器
      const writer = createChatStreamWriter(stream, {
        onEvent: (event) => this.updateStats(context, event),
        onError: (error) => this.handleStreamError(context, error, stream)
      });

      // 3. 创建事件序列化器
      const sequencer = createChatSequencer({
        chunkSize: context.options.maxTokensPerChunk || this.config.maxTokensPerChunk,
        chunkDelayMs: context.options.chunkDelayMs || this.config.defaultChunkDelayMs,
        enableDelay: !!context.options.chunkDelayMs,
        reasoningMode: context.options.reasoningMode || this.config.reasoningMode,
        reasoningTextPrefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
      });

      // 4. 生成事件序列并写入流
      const eventStream = sequencer.sequenceResponse(response, context.model, context.requestId);
      await writer.writeChatEvents(eventStream);

      // 5. 完成流
      writer.complete();

    } catch (error) {
      throw this.wrapError('RESPONSE_CONVERSION_ERROR', error as Error, context.requestId);
    }
  }

  /**
   * 验证响应格式
   */
  private validateResponse(response: ChatCompletionResponse): void {
    if (!response || typeof response !== 'object' || !Array.isArray(response.choices) || !response.model) {
      throw new Error('Invalid ChatCompletionResponse format');
    }
    if (typeof response.id !== 'string' || !response.id.trim()) {
      throw new Error('Invalid ChatCompletionResponse: missing id');
    }
    if (typeof response.created !== 'number' || !Number.isFinite(response.created) || response.created <= 0) {
      throw new Error('Invalid ChatCompletionResponse: missing created timestamp');
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(context: ChatJsonToSseContext, event: any): void {
    const et = event?.event || event?.type;
    if (typeof et !== 'string' || !et.trim()) {
      throw new Error('Chat SSE event missing event/type for stats update');
    }
    if (typeof context.eventStats.totalEvents === 'number') context.eventStats.totalEvents++;
    if (context.eventStats.eventTypes) {
      context.eventStats.eventTypes[et] = (context.eventStats.eventTypes[et] || 0) + 1;
    }

    if (et === 'error' || et === 'chat.error') {
      context.eventStats.errorCount++;
    }

    // 更新时间戳
    if (et === 'chat_chunk') {
      context.eventStats.totalChunks++;
      const chunkObj = typeof event?.data === 'string' ? JSON.parse(event.data) : event?.data;
      const choice = chunkObj?.choices?.[0];
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === 'string') {
        context.eventStats.totalTokens += deltaContent.length;
      }
    }

    if (typeof event?.timestamp === 'number') context.eventStats.lastEventTime = event.timestamp;
  }

  /**
   * 包装错误
   */
  private wrapError(code: string, originalError: Error, requestId: string): Error {
    return ErrorUtils.createError(
      `${code}: ${originalError.message}`,
      code,
      { requestId, originalError }
    );
  }

  /**
   * 处理流错误
   */
  private handleStreamError(context: ChatJsonToSseContext, error: Error, stream: PassThrough): void {
    context.eventStats.errorCount++;

    const wrappedError = this.wrapError('STREAM_ERROR', error, context.requestId);

    if (stream.writable) {
      stream.destroy(wrappedError);
    }
  }

  /**
   * 完成流
   */
  private completeStream(context: ChatJsonToSseContext, stream: PassThrough): void {
    context.eventStats.endTime = Date.now();
    context.eventStats.duration = context.eventStats.endTime - context.eventStats.startTime;

    if (stream.writable) {
      stream.end();
    }
  }

  /**
   * 中止流
   */
  private abortStream(context: ChatJsonToSseContext, stream: PassThrough, error?: Error): void {
    context.eventStats.endTime = Date.now();
    context.eventStats.duration = context.eventStats.endTime - context.eventStats.startTime;

    if (error) {
      context.eventStats.errorCount++;
    }

    if (stream.writable) {
      stream.destroy(error);
    }
  }

  /**
   * 创建响应上下文
   */
  private createResponseContext(response: ChatCompletionResponse, options: ChatJsonToSseOptions): ChatJsonToSseContext {
    const eventStats: ChatEventStats = {
      totalChunks: 0,
      totalTokens: 0,
      totalChoices: 0,
      totalToolCalls: 0,
      startTime: Date.now(),
      tokenRate: 0,
      chunkRate: 0,
      errorCount: 0,
      retryCount: 0,
      totalEvents: 0,
      eventTypes: {}
    };

    return {
      requestId: options.requestId,
      model: response.model,
      chatResponse: response,
      options,
      startTime: Date.now(),
      sequenceCounter: 0,
      choiceIndexCounter: 0,
      toolCallIndexCounter: 0,
      currentChunk: {},
      isStreaming: true,
      eventStats
    };
  }

}

// 为了向后兼容，导出原有名称
export const ChatJsonToSseConverter = ChatJsonToSseConverterRefactored;
