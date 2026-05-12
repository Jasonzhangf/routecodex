import { DEFAULT_ANTHROPIC_CONVERSION_CONFIG } from '../types/index.js';
import type {
  AnthropicMessageResponse,
  AnthropicSseEvent,
  SseToAnthropicJsonOptions,
  SseToAnthropicJsonContext
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createSseParser } from './parsers/sse-parser.js';
import { createAnthropicResponseBuilder } from './builders/anthropic-response-builder.js';

type AnthropicSseToJsonConverterConfig = {
  enableEventValidation: boolean;
  strictMode: boolean;
} & typeof DEFAULT_ANTHROPIC_CONVERSION_CONFIG;

type SseFailureMetadata = {
  upstreamCode: string;
  statusCode: number;
  retryable: boolean;
};

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

export class AnthropicSseToJsonConverter {
  private config: AnthropicSseToJsonConverterConfig = {
    enableEventValidation: true,
    strictMode: false,
    ...DEFAULT_ANTHROPIC_CONVERSION_CONFIG
  };
  private contexts = new Map<string, SseToAnthropicJsonContext>();

  constructor(config?: Partial<AnthropicSseToJsonConverterConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToAnthropicJsonOptions
  ): Promise<AnthropicMessageResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    const parser = createSseParser({
      enableStrictValidation: this.config.enableEventValidation,
      enableEventRecovery: !this.config.strictMode,
      allowedEventTypes: new Set([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
        'error'
      ])
    });
    const builder = createAnthropicResponseBuilder({
      reasoningMode: options.reasoningMode ?? this.config.reasoningMode,
      reasoningTextPrefix: options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
    });

    try {
      for await (const result of parser.parseStreamAsync(this.chunkStrings(sseStream, context))) {
        if (!result.success || !result.event) {
          if (this.config.strictMode) {
            throw new Error(result.error || 'Failed to parse Anthropic SSE event');
          }
          continue;
        }

        context.eventStats.firstEventAtMs ??= Date.now();
        context.eventStats.lastEventAtMs = Date.now();

        const upstreamError = this.extractAnthropicErrorEventMessage(result.event);
        if (upstreamError) {
          throw new Error(upstreamError);
        }

        if ((result.event as AnthropicSseEvent).protocol !== 'anthropic-messages') {
          continue;
        }
        const builderStartedAt = Date.now();
        builder.processEvent(result.event as AnthropicSseEvent);
        context.eventStats.builderMs = (context.eventStats.builderMs ?? 0) + Math.max(0, Date.now() - builderStartedAt);
        this.updateStats(context, result.event as AnthropicSseEvent);
      }

      const resultStartedAt = Date.now();
      const outcome = builder.getResult();
      context.eventStats.builderMs = (context.eventStats.builderMs ?? 0) + Math.max(0, Date.now() - resultStartedAt);
      if (!outcome.success || !outcome.response) {
        throw outcome.error || new Error('Anthropic SSE conversion incomplete');
      }
      context.isCompleted = true;
      context.eventStats.endTime = Date.now();
      this.attachDecodeStats(outcome.response, context);
      return outcome.response;
    } catch (error) {
      context.eventStats.errors = (context.eventStats.errors ?? 0) + 1;
      if (this.isTerminatedError(error)) {
        try {
          const salvaged = builder.getResult();
          if (salvaged.success && salvaged.response) {
            context.isCompleted = true;
            context.eventStats.endTime = Date.now();
            return salvaged.response;
          }
        } catch {
          // ignore salvage failure, fall through to wrapped error
        }
      }
      throw this.wrapError('ANTHROPIC_SSE_TO_JSON_FAILED', error as Error, options.requestId);
    } finally {
      this.contexts.delete(options.requestId);
    }
  }

  private isTerminatedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    const normalized = typeof message === 'string' ? message.toLowerCase() : '';
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

  private resolveSseFailureMetadata(error: Error): SseFailureMetadata {
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
    if (explicitUpstreamCode || explicitStatusCode !== undefined || explicitRetryable !== undefined) {
      return {
        upstreamCode: explicitUpstreamCode || errorCode || 'ANTHROPIC_SSE_TO_JSON_FAILED',
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
    return { upstreamCode: errorCode || 'ANTHROPIC_SSE_TO_JSON_FAILED', statusCode: 502, retryable: true };
  }

  private createContext(options: SseToAnthropicJsonOptions): SseToAnthropicJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options,
      startTime: Date.now(),
      eventStats: {
        totalEvents: 0,
        contentBlocks: 0,
        toolUseBlocks: 0,
        thinkingBlocks: 0,
        textBlocks: 0,
        errors: 0,
        chunkCount: 0,
        byteCount: 0,
        parserMs: 0,
        builderMs: 0,
        messageStopSeen: false,
        startTime: Date.now()
      },
      isCompleted: false
    };
  }

  private async *chunkStrings(
    stream: AsyncIterable<string | Buffer>,
    context: SseToAnthropicJsonContext
  ): AsyncGenerator<string> {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const chunk = next.value;
      const now = Date.now();
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      context.eventStats.firstFrameAtMs ??= now;
      context.eventStats.lastFrameAtMs = now;
      context.eventStats.chunkCount = (context.eventStats.chunkCount ?? 0) + 1;
      context.eventStats.byteCount = (context.eventStats.byteCount ?? 0) + Buffer.byteLength(text);
      context.eventStats.firstChunkAtMs ??= now;
      context.eventStats.lastChunkAtMs = now;
      const parserStartedAt = Date.now();
      yield text;
      context.eventStats.parserMs = (context.eventStats.parserMs ?? 0) + Math.max(0, Date.now() - parserStartedAt);
    }
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context: SseToAnthropicJsonContext
  ): Promise<IteratorResult<T>> {
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private resolveTimeoutState(context: SseToAnthropicJsonContext): {
    timeoutMs: number;
    anchorMs: number;
    code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT' | 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT' | 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT';
  } {
    const options = (context as unknown as { options?: SseToAnthropicJsonOptions }).options;
    if (context.eventStats.firstFrameAtMs === undefined) {
      const configured = Number(options?.firstFrameTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        anchorMs: context.startTime,
        code: 'UPSTREAM_STREAM_NO_FRAME_TIMEOUT'
      };
    }
    if (context.eventStats.firstContentAtMs === undefined) {
      const configured = Number(options?.preAnchorIdleTimeoutMs ?? options?.noContentTimeoutMs);
      return {
        timeoutMs: Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS,
        anchorMs: context.eventStats.lastFrameAtMs ?? context.eventStats.firstFrameAtMs ?? context.startTime,
        code: 'UPSTREAM_STREAM_PRE_ANCHOR_IDLE_TIMEOUT'
      };
    }
    const configured = Number(options?.contentIdleTimeoutMs);
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
    context: SseToAnthropicJsonContext
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

  private markSemanticContentSeen(context: SseToAnthropicJsonContext): void {
    const now = Date.now();
    context.eventStats.firstContentAtMs ??= now;
    context.eventStats.lastContentAtMs = now;
  }

  private updateStats(context: SseToAnthropicJsonContext, event: AnthropicSseEvent): void {
    context.eventStats.totalEvents += 1;
    if (event.type === 'content_block_start') {
      context.eventStats.contentBlocks += 1;
      const blockType = (event.data as any)?.content_block?.type;
      if (blockType === 'tool_use') context.eventStats.toolUseBlocks += 1;
      if (blockType === 'thinking' || blockType === 'redacted_thinking') context.eventStats.thinkingBlocks += 1;
      if (blockType === 'text') context.eventStats.textBlocks += 1;
    }
    if (event.type === 'content_block_delta') {
      const delta = (event.data as any)?.delta;
      const text = typeof delta?.text === 'string' ? delta.text : '';
      const partialJson = typeof delta?.partial_json === 'string' ? delta.partial_json : '';
      const thinking = typeof delta?.thinking === 'string' ? delta.thinking : '';
      if (
        text.length > 0
        || partialJson.length > 0
        || (thinking.length > 0 && hasExplicitToolWrapperProgress(thinking))
      ) {
        this.markSemanticContentSeen(context);
      }
    }
    if (event.type === 'message_stop') {
      context.eventStats.messageStopSeen = true;
    }
  }

  private attachDecodeStats(response: AnthropicMessageResponse, context: SseToAnthropicJsonContext): void {
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        ...context.eventStats,
        streamMs:
          context.eventStats.firstChunkAtMs !== undefined && context.eventStats.lastChunkAtMs !== undefined
            ? Math.max(0, context.eventStats.lastChunkAtMs - context.eventStats.firstChunkAtMs)
            : undefined,
        eventSpanMs:
          context.eventStats.firstEventAtMs !== undefined && context.eventStats.lastEventAtMs !== undefined
            ? Math.max(0, context.eventStats.lastEventAtMs - context.eventStats.firstEventAtMs)
            : undefined
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }

  private extractAnthropicErrorEventMessage(event: unknown): string | null {
    const node = event as {
      type?: unknown;
      data?: unknown;
    };
    if (node?.type !== 'error') {
      return null;
    }

    const dataNode = node.data as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      code?: unknown;
      request_id?: unknown;
      requestId?: unknown;
    } | string | null | undefined;

    if (typeof dataNode === 'string' && dataNode.trim()) {
      return `Anthropic SSE error event: ${dataNode.trim()}`;
    }

    const nestedError = dataNode && typeof dataNode === 'object' ? dataNode.error : undefined;
    const message =
      (nestedError && typeof nestedError.message === 'string' && nestedError.message.trim()) ||
      (dataNode && typeof dataNode === 'object' && typeof dataNode.message === 'string' && dataNode.message.trim()) ||
      'Anthropic SSE upstream returned an error event';

    const code =
      (nestedError && typeof nestedError.code === 'string' && nestedError.code.trim()) ||
      (nestedError && typeof nestedError.code === 'number' ? String(nestedError.code) : '') ||
      (dataNode && typeof dataNode === 'object' && typeof dataNode.code === 'string' && dataNode.code.trim()) ||
      (dataNode && typeof dataNode === 'object' && typeof dataNode.code === 'number' ? String(dataNode.code) : '');

    const requestId =
      (dataNode && typeof dataNode === 'object' && typeof dataNode.request_id === 'string' && dataNode.request_id.trim()) ||
      (dataNode && typeof dataNode === 'object' && typeof dataNode.requestId === 'string' && dataNode.requestId.trim()) ||
      '';

    const parts: string[] = ['Anthropic SSE error event'];
    if (code) {
      parts.push(`[${code}]`);
    }
    parts.push(message);
    if (requestId) {
      parts.push(`(request_id=${requestId})`);
    }
    return parts.join(' ');
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    const failure = this.resolveSseFailureMetadata(error);
    const wrapped = ErrorUtils.createError(error.message, code, {
      requestId,
      upstreamCode: failure.upstreamCode,
      statusCode: failure.statusCode,
      retryable: failure.retryable,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    }) as Error & {
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
}
