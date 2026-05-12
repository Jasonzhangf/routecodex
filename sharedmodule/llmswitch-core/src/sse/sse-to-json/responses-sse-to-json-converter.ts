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

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_NO_CONTENT_TIMEOUT_MS = 120_000;
const DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 300_000;

const hasExplicitToolWrapperProgress = (text: string): boolean => {
  if (!text) {
    return false;
  }
  return (
    /<tool_call\b/i.test(text)
    || /<function_calls?\b/i.test(text)
    || /<<\s*RCC_TOOL_CALLS(?:_JSON)?/i.test(text)
    || /<use_mcp_tool\b/i.test(text)
  );
};

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
    timeoutMs: 900000,
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
      for await (const parseResult of parser.parseStreamAsync(this.chunkStrings(readableStream, context))) {
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

          // 一旦 builder 已进入 completed（例如 response.required_action / response.completed），
          // 必须立即结束读取，不能继续等待上游自己关闭连接。
          // 否则 DeepSeek Web 这类上游会把已可恢复的 tool_calls / completed 长时间挂住，
          // 导致 decode.sse 虚高甚至命中后续超时。
          if (responseBuilder.getState() === 'completed') {
            context.isCompleted = true;
            break;
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
            this.attachDecodeStats(maybe.response, context);
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

      this.attachDecodeStats(result.response, context);
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
          this.attachDecodeStats(salvaged.response, context);
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
    const code = (error as { code?: unknown }).code;
    const normalized = typeof msg === 'string' ? msg.toLowerCase() : '';
    const normalizedCode = typeof code === 'string' ? code.toLowerCase() : '';
    return (
      normalized.includes('terminated') ||
      normalizedCode.includes('terminated') ||
      normalized.includes('upstream_stream_idle_timeout') ||
      normalizedCode.includes('upstream_stream_idle_timeout') ||
      normalized.includes('upstream_stream_no_content_timeout') ||
      normalizedCode.includes('upstream_stream_no_content_timeout') ||
      normalized.includes('upstream_stream_content_idle_timeout') ||
      normalizedCode.includes('upstream_stream_content_idle_timeout') ||
      normalized.includes('upstream_stream_timeout') ||
      normalizedCode.includes('upstream_stream_timeout')
    );
  }

  private resolveSseFailureMetadata(error: Error): {
    upstreamCode: string;
    statusCode: number;
    retryable: boolean;
  } {
    const explicitUpstreamCode =
      typeof (error as { upstreamCode?: unknown }).upstreamCode === 'string'
        ? String((error as { upstreamCode?: string }).upstreamCode).trim()
        : '';
    const explicitStatusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? Number((error as { statusCode?: number }).statusCode)
        : typeof (error as { status?: unknown }).status === 'number'
          ? Number((error as { status?: number }).status)
          : undefined;
    const explicitRetryable =
      typeof (error as { retryable?: unknown }).retryable === 'boolean'
        ? Boolean((error as { retryable?: boolean }).retryable)
        : undefined;
    const errorCode = typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code?: string }).code).trim().toUpperCase()
      : '';
    const normalized = error.message.toLowerCase();
    const normalizedUpstreamCode = explicitUpstreamCode.toLowerCase();
    if (
      normalizedUpstreamCode.includes('context_length_exceeded')
      || normalizedUpstreamCode.includes('context_window_exceeded')
      || normalizedUpstreamCode.includes('model_context_window_exceeded')
      || errorCode === 'CONTEXT_LENGTH_EXCEEDED'
      || normalized.includes('context_length_exceeded')
      || normalized.includes('context window')
    ) {
      return {
        upstreamCode: explicitUpstreamCode || 'context_length_exceeded',
        statusCode: explicitStatusCode ?? 400,
        retryable: explicitRetryable ?? false
      };
    }
    if (explicitUpstreamCode || explicitStatusCode !== undefined || explicitRetryable !== undefined) {
      return {
        upstreamCode: explicitUpstreamCode || errorCode || 'SSE_TO_JSON_ERROR',
        statusCode: explicitStatusCode ?? 502,
        retryable: explicitRetryable ?? true
      };
    }
    if (errorCode === 'UPSTREAM_STREAM_IDLE_TIMEOUT' || normalized.includes('upstream_stream_idle_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_IDLE_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT' || normalized.includes('upstream_stream_no_content_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT' || normalized.includes('upstream_stream_content_idle_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_TIMEOUT' || normalized.includes('upstream_stream_timeout')) {
      return { upstreamCode: 'UPSTREAM_STREAM_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_HEADERS_TIMEOUT' || normalized.includes('upstream_headers_timeout')) {
      return { upstreamCode: 'UPSTREAM_HEADERS_TIMEOUT', statusCode: 504, retryable: true };
    }
    if (errorCode === 'UPSTREAM_STREAM_INCOMPLETE' || normalized.includes('stream incomplete')) {
      return { upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE', statusCode: 502, retryable: true };
    }
    if (errorCode === 'TERMINATED' || normalized.includes('terminated')) {
      return { upstreamCode: 'UPSTREAM_STREAM_TERMINATED', statusCode: 502, retryable: true };
    }
    return { upstreamCode: errorCode || 'SSE_TO_JSON_ERROR', statusCode: 502, retryable: true };
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

  private async *chunkStrings(stream: Readable, context: SseToResponsesJsonContext): AsyncGenerator<string> {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const chunk = next.value;
      const now = Date.now();
      context.eventStats.firstFrameAtMs ??= now;
      context.eventStats.lastFrameAtMs = now;
      if (typeof chunk === 'string') {
        yield chunk;
        continue;
      }
      if (Buffer.isBuffer(chunk)) {
        yield chunk.toString();
        continue;
      }
      yield this.serializeEventToSSE(chunk as Partial<ResponsesSseEvent> | Record<string, unknown>);
    }
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context: SseToResponsesJsonContext
  ): Promise<IteratorResult<T>> {
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private resolveTimeoutState(context: SseToResponsesJsonContext): {
    timeoutMs: number;
    anchorMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  } {
    if (context.eventStats.firstFrameAtMs === undefined) {
      const configured = Number(context.options.firstFrameTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        anchorMs: context.startTime,
        code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
      };
    }
    if (context.eventStats.firstContentAtMs === undefined) {
      const configured = Number(context.options.preAnchorIdleTimeoutMs ?? context.options.noContentTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS,
        anchorMs: context.eventStats.lastFrameAtMs ?? context.eventStats.firstFrameAtMs ?? context.startTime,
        code: 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
      };
    }
    const configured = Number(context.options.contentIdleTimeoutMs);
    return {
      timeoutMs: Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_CONTENT_IDLE_TIMEOUT_MS,
      anchorMs: context.eventStats.lastContentAtMs ?? context.eventStats.firstContentAtMs ?? context.startTime,
      code: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    };
  }

  private async raceWithTimeoutState<T>(
    pending: Promise<IteratorResult<T>>,
    context: SseToResponsesJsonContext
  ): Promise<IteratorResult<T>> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutState = this.resolveTimeoutState(context);
    const remainingTimeoutMs = Math.max(1, timeoutState.anchorMs + Math.max(1, timeoutState.timeoutMs) - Date.now());
    try {
      return await Promise.race([
        pending,
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(
            () => reject(this.createSemanticTimeoutError(timeoutState)),
            remainingTimeoutMs
          );
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private createSemanticTimeoutError(timeoutState: {
    timeoutMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  }): Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    upstreamCode?: string;
    requestExecutorProviderErrorStage?: string;
  } {
    const { code, timeoutMs } = timeoutState;
    const message =
      code === 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
        ? `Upstream stream produced no frame within ${timeoutMs}ms`
        : code === 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
          ? `Upstream stream produced frames but no semantic progress within ${timeoutMs}ms`
          : `Upstream stream idle after semantic content for ${timeoutMs}ms`;
    const error = new Error(message) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    error.code = code;
    error.status = 504;
    error.statusCode = 504;
    error.retryable = true;
    error.upstreamCode = code;
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return error;
  }

  private markSemanticContentSeen(context: SseToResponsesJsonContext): void {
    const now = Date.now();
    context.eventStats.firstContentAtMs ??= now;
    context.eventStats.lastContentAtMs = now;
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

    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0 && hasExplicitToolWrapperProgress(delta)) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const delta = typeof (event.data as { delta?: unknown } | undefined)?.delta === 'string'
          ? String((event.data as { delta?: string }).delta)
          : '';
        if (delta.length > 0) {
          this.markSemanticContentSeen(context);
        }
        break;
      }
      default:
        break;
    }

    // 根据事件类型更新特定统计
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
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
    const failure = this.resolveSseFailureMetadata(originalError);
    const wrapped = ErrorUtils.createError(
      `${code}: ${originalError.message}`,
      code,
      {
        requestId,
        originalError,
        upstreamCode: failure.upstreamCode,
        statusCode: failure.statusCode,
        retryable: failure.retryable,
        requestExecutorProviderErrorStage: 'provider.sse_decode'
      }
    ) as Error & {
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    wrapped.status = failure.statusCode;
    wrapped.statusCode = failure.statusCode;
    wrapped.retryable = failure.retryable;
    wrapped.upstreamCode = failure.upstreamCode;
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
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
      currentResponse: {},
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

  private attachDecodeStats(response: ResponsesResponse, context: SseToResponsesJsonContext): void {
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        ...context.eventStats,
        firstFrameAtMs: context.eventStats.firstFrameAtMs,
        lastFrameAtMs: context.eventStats.lastFrameAtMs,
        firstContentAtMs: context.eventStats.firstContentAtMs,
        lastContentAtMs: context.eventStats.lastContentAtMs
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }
}

// 为了向后兼容，导出原有名称
export const ResponsesSseToJsonConverter = ResponsesSseToJsonConverterRefactored;
