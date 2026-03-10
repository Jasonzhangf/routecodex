/**
 * Responses SSE → JSON转换器（重构版本）
 * 使用函数化架构：解析 + 构建 + 验证分离
 */

import { Readable } from 'stream';
import type {
  ResponsesResponse,
  ResponsesSseEvent,
  SseToResponsesJsonContext,
  SseToResponsesJsonOptions,
  ResponsesEventStats,
  ResponsesSseEventStream
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createSseParser } from './parsers/sse-parser.js';
import { createResponseBuilder } from './builders/response-builder.js';

/**
 * 重构后的Responses SSE到JSON转换器
 * 采用函数化架构，专注于编排而非具体业务逻辑
 */
export class ResponsesSseToJsonConverterRefactored {
  private config: {
    timeoutMs: number;
    enableEventValidation: boolean;
    enableSequenceValidation: boolean;
    strictMode: boolean;
    validateOutputItems: boolean;
  } = {
    timeoutMs: 30000,
    enableEventValidation: true,
    enableSequenceValidation: false,
    strictMode: false,
    validateOutputItems: true
  };
  private contexts = new Map<string, SseToResponsesJsonContext>();

  constructor(config?: Partial<ResponsesSseToJsonConverterRefactored['config']>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * 将SSE流转换为Responses响应
   */
  async convertSseToJson(
    sseStream: ResponsesSseEventStream,
    options: SseToResponsesJsonOptions
  ): Promise<ResponsesResponse> {
    // 1. 创建上下文
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    let responseBuilder: ReturnType<typeof createResponseBuilder> | null = null;

    try {
      // 2. 创建解析器
      const parser = createSseParser({
        enableStrictValidation: this.config.enableEventValidation,
        enableEventRecovery: !this.config.strictMode
      });

      // 3. 创建响应构建器
      responseBuilder = createResponseBuilder({
        enableStrictValidation: false,
        enableEventRecovery: !this.config.strictMode,
        maxOutputItems: 50,
        maxContentParts: 100
      });

      // 4. 创建可读流（适配不同的输入源）
      const readableStream = this.createReadableStream(sseStream);

      // 5. 流式处理SSE数据（按增量缓冲解析，避免跨 chunk 的事件被截断）
      // 注意：不要对每个 chunk 独立 parse；必须使用一个持续的 async 解析器维持缓冲区。
      for await (const parseResult of parser.parseStreamAsync(this.chunkStrings(readableStream))) {
        if (context.isCompleted) {
          break;
        }

        if (parseResult.success && parseResult.event) {
          const event = parseResult.event as ResponsesSseEvent;

          // 验证序列号
          if (this.config.enableSequenceValidation && !this.validateSequenceNumber(event, context)) {
            throw new Error(`Invalid sequence number: ${event.sequenceNumber}`);
          }

          // 处理事件
          const success = responseBuilder.processEvent(event);
          if (!success && this.config.strictMode) {
            const result = responseBuilder.getResult();
            throw new Error(`Failed to process event: ${result.error?.message}`);
          }

          // 更新统计
          this.updateStats(context, event);

          // 回调
          if (options.onEvent) {
            options.onEvent(event);
          }
        } else if (!parseResult.success && this.config.strictMode) {
          throw new Error(`Failed to parse SSE event: ${parseResult.error}`);
        }
      }

      // 6. 获取最终结果
      const result = responseBuilder.getResult();

      if (!result.success) {
        // 容错：若已观察到 response.completed 事件或整体已完成，但构建器仍报告未完成，
        // 这里按已完成处理，避免上游省略 response.done 导致误报失败。
        const seenCompleted = context.eventStats.eventTypes['response.completed'] > 0;
        if (seenCompleted) {
          const maybe = responseBuilder.getResult();
          if (maybe.success && maybe.response) {
            return maybe.response;
          }
        }
        throw result.error || new Error('Failed to build response');
      }

      // 7. 标记完成
      context.isCompleted = true;
      context.endTime = Date.now();
      context.duration = context.endTime - context.startTime;

      // 8. 调用完成回调
      if (options.onCompletion) {
        options.onCompletion(result.response);
      }

      return result.response;

    } catch (error) {
      // 容错：部分 OpenAI-compatible 上游（例如 LM Studio）在产出 tool_call 后会直接断开 SSE 连接，
      // undici 会抛出 "terminated"。若此时已聚合出可用 response，则应优先返回而不是把它当作致命错误。
      if (responseBuilder && this.isTerminatedError(error)) {
        try {
          const salvaged = responseBuilder.getResult();
          if (salvaged.success && salvaged.response) {
            context.isCompleted = true;
            context.endTime = Date.now();
            context.duration = context.endTime - context.startTime;
            if (options.onCompletion) {
              options.onCompletion(salvaged.response);
            }
            return salvaged.response;
          }
        } catch {
          // ignore salvage failure, fall through to normal error path
        }
      }

      context.isCompleted = true;
      context.endTime = Date.now();
      context.duration = context.endTime - context.startTime;

      // 调用错误回调
      if (options.onError) {
        options.onError(error as Error);
      }

      throw this.wrapError('SSE_TO_JSON_ERROR', error as Error, options.requestId);
    } finally {
      // 清理上下文
      this.clearContext(options.requestId);
    }
  }

  private isTerminatedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const msg = (error as { message?: unknown }).message;
    if (typeof msg !== 'string') {
      return false;
    }
    const normalized = msg.toLowerCase();
    return (
      normalized.includes('terminated') ||
      normalized.includes('upstream_stream_idle_timeout') ||
      normalized.includes('upstream_stream_timeout')
    );
  }

  /**
   * 创建可读流
   */
  private createReadableStream(sseStream: ResponsesSseEventStream): Readable {
    if (sseStream instanceof Readable) {
      return sseStream;
    }

    // 如果是异步可迭代对象，包装为流
    return Readable.from(this.convertAsyncIterableToStream(sseStream));
  }

  /**
   * 将异步可迭代对象转换为流
   */
  private async *convertAsyncIterableToStream(sseStream: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
    for await (const chunk of sseStream) {
      if (typeof chunk === 'string') {
        yield Buffer.from(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        yield chunk;
      } else {
        // 假设是SSE事件对象，序列化为SSE格式
        const serialized = this.serializeEventToSSE(chunk);
        yield Buffer.from(serialized);
      }
    }
  }

  /**
   * 将事件对象序列化为SSE格式（简单实现）
   */
  private serializeEventToSSE(event: Partial<ResponsesSseEvent> | Record<string, unknown>): string {
    const type = typeof event.type === 'string' ? event.type : 'data';
    const data = event.data ? JSON.stringify(event.data) : '';
    return `event: ${type}\ndata: ${data}\n\n`;
  }

  private async *chunkStrings(stream: Readable): AsyncGenerator<string> {
    for await (const chunk of stream) {
      yield typeof chunk === 'string' ? chunk : chunk.toString();
    }
  }

  /**
   * 验证序列号
   */
  private validateSequenceNumber(event: ResponsesSseEvent, context: SseToResponsesJsonContext): boolean {
    if (typeof event.sequenceNumber !== 'number') {
      context.lastSequenceNumber += 1;
      event.sequenceNumber = context.lastSequenceNumber;
      return true;
    }

    if (event.sequenceNumber <= context.lastSequenceNumber) {
      return false;
    }

    context.lastSequenceNumber = event.sequenceNumber;
    return true;
  }

  /**
   * 更新统计信息
   */
  private updateStats(context: SseToResponsesJsonContext, event: ResponsesSseEvent): void {
    context.eventStats.totalEvents++;
    context.eventStats.eventTypes[event.type] = (context.eventStats.eventTypes[event.type] || 0) + 1;

    // 根据事件类型更新特定统计
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.completed':
      case 'response.required_action':
      case 'response.done':
        context.eventStats.messageEventsCount++;
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        context.eventStats.outputItemsCount++;
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        context.eventStats.contentPartsCount++;
        break;
      case 'response.output_text.delta':
      case 'response.output_text.done':
        context.eventStats.deltaEventsCount++;
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
        context.eventStats.reasoningEventsCount++;
        break;
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        context.eventStats.functionCallEventsCount++;
        break;
      case 'response.error':
        context.eventStats.errorCount++;
        break;
    }

    // 更新时间戳
    context.eventStats.lastEventTime = event.timestamp;
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
   * 创建上下文
   */
  private createContext(options: SseToResponsesJsonOptions): SseToResponsesJsonContext {
    const eventStats: ResponsesEventStats = {
      totalEvents: 0,
      eventTypes: {},
      startTime: Date.now(),
      outputItemsCount: 0,
      contentPartsCount: 0,
      deltaEventsCount: 0,
      reasoningEventsCount: 0,
      functionCallEventsCount: 0,
      messageEventsCount: 0,
      errorCount: 0
    };

    return {
      requestId: options.requestId,
      model: options.model,
      options,
      startTime: Date.now(),
      aggregatedEvents: [],
      currentResponse: {},
      outputItemBuilders: new Map(),
      eventStats,
      isCompleted: false,
      isResponseCreated: false,
      isInProgress: false,
      lastSequenceNumber: -1
    };
  }

  /**
   * 获取上下文
   */
  getContext(requestId: string): SseToResponsesJsonContext | undefined {
    return this.contexts.get(requestId);
  }

  /**
   * 清理上下文
   */
  clearContext(requestId: string): void {
    this.contexts.delete(requestId);
  }

  /**
   * 获取所有活跃的上下文
   */
  getActiveContexts(): Map<string, SseToResponsesJsonContext> {
    return new Map(this.contexts);
  }
}

// 为了向后兼容，导出原有名称
export const ResponsesSseToJsonConverter = ResponsesSseToJsonConverterRefactored;
