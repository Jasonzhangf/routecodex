/**
 * Responses JSON → SSE转换器（重构版本）
 * 使用函数化架构：事件生成 + 序列化 + 写入分离
 */

// feature_id: sse.responses_encode_projection
import { PassThrough } from 'stream';
import { DEFAULT_RESPONSES_CONVERSION_CONFIG } from '../types/index.js';
import type {
  ResponsesResponse,
  ResponsesSseEvent,
  ResponsesJsonToSseContext,
  ResponsesJsonToSseOptions,
  ResponsesEventStats,
  ResponsesSseEventStream
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createResponsesSequencer } from './sequencers/responses-sequencer.js';
import { createResponsesStreamWriter } from '../shared/writer.js';


// Memory management constants
const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONTEXTS = 2048;

/**
 * Prune contexts by TTL and max-size
 */
function pruneResponsesContexts(contexts: Map<string, ResponsesJsonToSseContext>): void {
  const now = Date.now();
  // TTL sweep
  for (const [id, ctx] of contexts) {
    if (now - ctx.startTime > CONTEXT_TTL_MS) {
      contexts.delete(id);
    }
  }
  // Max-size protection: remove oldest 25% if at capacity
  if (contexts.size >= MAX_CONTEXTS) {
    const sorted = [...contexts.entries()].sort((a, b) => a[1].startTime - b[1].startTime);
    const toRemove = Math.ceil(sorted.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      contexts.delete(sorted[i][0]);
    }
  }
}

/**
 * 重构后的Responses JSON到SSE转换器
 * 采用函数化架构，专注于编排而非具体业务逻辑
 */
export class ResponsesJsonToSseConverterRefactored {
  private config = DEFAULT_RESPONSES_CONVERSION_CONFIG;
  private contexts = new Map<string, ResponsesJsonToSseContext>();

  constructor(config?: Partial<typeof DEFAULT_RESPONSES_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * 将Responses响应转换为SSE流
   */
  async convertResponseToJsonToSse(
    response: ResponsesResponse,
    options: ResponsesJsonToSseOptions
  ): Promise<ResponsesSseEventStream> {
    // TTL + max-size prune on every public entry
    pruneResponsesContexts(this.contexts);
    try {
      this.validateResponse(response);
    } catch (error) {
      throw this.wrapError('RESPONSE_CONVERSION_ERROR', error as Error, options.requestId);
    }

    // 1. 创建上下文
    const context = this.createResponseContext(response, options);
    this.contexts.set(options.requestId, context);

    // 2. 创建底层流
    const stream = new PassThrough({ objectMode: true });

    // 3. 创建SSE事件流接口
    const sseStream: ResponsesSseEventStream = Object.assign(stream, {
      protocol: 'responses' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => context.eventStats,
      getConfig: () => this.config,
      complete: () => this.completeStream(context, stream),
      abort: (error?: Error) => this.abortStream(context, stream, error)
    }) as ResponsesSseEventStream;

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
    response: ResponsesResponse,
    context: ResponsesJsonToSseContext,
    stream: PassThrough
  ): Promise<void> {
    try {
      // 1. 验证响应
      this.validateResponse(response);

      // 2. 创建流写入器
      const writer = createResponsesStreamWriter(stream, {
        onEvent: (event) => this.updateStats(context, event as ResponsesSseEvent),
        onError: (error) => this.handleStreamError(context, error, stream)
      });

      // 3. 创建事件序列化器
      const sequencer = createResponsesSequencer({
        chunkSize: context.options.chunkSize || this.config.defaultChunkSize,
        chunkDelayMs: context.options.delayMs || this.config.defaultDelayMs,
        enableDelay: !!context.options.delayMs,
        enableValidation: this.config.enableEventValidation
      });

      // 4. 生成事件序列并写入流
      const eventStream = sequencer.sequenceResponse(response, context.requestId);
      await writer.writeResponsesEvents(eventStream);

      // 5. 完成流
      writer.complete();

    } catch (error) {
      throw this.wrapError('RESPONSE_CONVERSION_ERROR', error as Error, context.requestId);
    } finally {
      this.contexts.delete(context.requestId);
    }
  }

  /**
   * 验证响应格式
   */
  private validateResponse(response: ResponsesResponse): void {
    if (!response.id || !response.model || !response.object) {
      throw new Error('Invalid ResponsesResponse: missing required fields');
    }

    if (response.object !== 'response') {
      throw new Error('Invalid ResponsesResponse: object must be "response"');
    }

    if (!Array.isArray(response.output)) {
      throw new Error('Invalid ResponsesResponse: output must be an array');
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(context: ResponsesJsonToSseContext, event: ResponsesSseEvent): void {
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
   * 处理流错误
   */
  private handleStreamError(context: ResponsesJsonToSseContext, error: Error, stream: PassThrough): void {
    context.eventStats.errorCount++;

    const wrappedError = this.wrapError('STREAM_ERROR', error, context.requestId);

    if (stream.writable) {
      stream.destroy(wrappedError);
    this.contexts.delete(context.requestId);
    }
  }

  /**
   * 完成流
   */
  private completeStream(context: ResponsesJsonToSseContext, stream: PassThrough): void {
    context.eventStats.endTime = Date.now();
    context.eventStats.duration = context.eventStats.endTime - context.eventStats.startTime;

    if (stream.writable) {
      stream.end();
    this.contexts.delete(context.requestId);
    }
  }

  /**
   * 中止流
   */
  private abortStream(context: ResponsesJsonToSseContext, stream: PassThrough, error?: Error): void {
    context.eventStats.endTime = Date.now();
    context.eventStats.duration = context.eventStats.endTime - context.eventStats.startTime;

    if (error) {
      context.eventStats.errorCount++;
    }

    if (stream.writable) {
      stream.destroy(error);
      this.contexts.delete(context.requestId);
    }
  }

  /**
   * 创建响应上下文
   */
  private createResponseContext(response: ResponsesResponse, options: ResponsesJsonToSseOptions): ResponsesJsonToSseContext {
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
      model: response.model,
      responsesResponse: response,
      options,
      startTime: Date.now(),
      sequenceCounter: 0,
      outputIndexCounter: 0,
      contentIndexCounter: new Map(),
      isStreaming: true,
      currentResponse: response,
      eventStats
    };
  }

  /**
   * 获取上下文
   */
  getContext(requestId: string): ResponsesJsonToSseContext | undefined {
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
  getActiveContexts(): Map<string, ResponsesJsonToSseContext> {
    return new Map(this.contexts);
  }
}

// 为了向后兼容，导出原有名称
export const ResponsesJsonToSseConverter = ResponsesJsonToSseConverterRefactored;
