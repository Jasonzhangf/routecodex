/**
 * Chat SSE -> JSON converter.
 * TS owns stream IO / timeout / abort plumbing only; Rust owns SSE decode semantics.
 */

// feature_id: sse.chat_stream_projection
import type {
  ChatCompletionResponse,
  ChatSseEvent,
  SseToChatJsonOptions,
  ChatEventStats
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { buildChatJsonFromSseWithNative } from '../../native/router-hotpath/native-chat-sse-event-payload.js';

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;
const DEFAULT_PRE_ANCHOR_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 300_000;

type DecodeStats = ChatEventStats & {
  firstFrameAtMs?: number;
  lastFrameAtMs?: number;
  firstContentAtMs?: number;
  lastContentAtMs?: number;
};

interface DecodeContext {
  requestId: string;
  model: string;
  options: SseToChatJsonOptions;
  startTime: number;
  isCompleted: boolean;
  eventStats: DecodeStats;
}

function nowMs(): number {
  return Date.now();
}

function isChatSseEvent(value: unknown): value is ChatSseEvent {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'event' in value);
}

function eventToWire(event: ChatSseEvent): string {
  const lines: string[] = [];
  if (event.event && event.event !== 'chat_chunk') {
    lines.push(`event: ${event.event}`);
  }
  lines.push(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {})}`);
  return `${lines.join('\n')}\n\n`;
}

function parseNativeProjectedError(error: unknown): Record<string, unknown> | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (_parseError) {
    return null;
  }
}

export class ChatSseToJsonConverter {
  private readonly stats = new Map<string, DecodeStats>();

  async convertSseToJson(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): Promise<ChatCompletionResponse> {
    const context = this.createContext(options);
    this.stats.set(options.requestId, context.eventStats);

    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    if (abortSignal && !abortSignal.aborted) {
      const onAbort = () => {
        context.isCompleted = true;
      };
      abortSignal.addEventListener('abort', onAbort);
      abortHandler = () => abortSignal.removeEventListener('abort', onAbort);
    }

    try {
      const bodyText = await this.collectBodyText(sseStream, context);
      if (abortSignal?.aborted) {
        const reason = (abortSignal as { reason?: unknown }).reason;
        const error = reason instanceof Error ? reason : new Error(String(reason ?? 'CLIENT_DISCONNECTED'));
        Object.assign(error, { code: 'CLIENT_DISCONNECTED', name: 'AbortError' });
        throw error;
      }

      const response = buildChatJsonFromSseWithNative({
        bodyText,
        requestId: options.requestId,
        model: options.model,
        config: {
          reasoningMode: options.reasoningMode,
          reasoningTextPrefix: options.reasoningTextPrefix
        }
      }) as unknown as ChatCompletionResponse;
      context.isCompleted = true;
      context.eventStats.endTime = nowMs();
      context.eventStats.duration = (context.eventStats.endTime - context.eventStats.startTime) / 1000;
      options.onCompletion?.(response);
      this.attachDecodeStats(response, context);
      return response;
    } catch (error) {
      context.eventStats.errorCount++;
      options.onError?.(error as Error);
      throw this.wrapSseError(error, 'SSE to JSON conversion failed');
    } finally {
      abortHandler?.();
      this.cleanup(options.requestId);
    }
  }

  async *aggregateSseStream(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): AsyncGenerator<ChatCompletionResponse> {
    const response = await this.convertSseToJson(sseStream, options);
    options.onPartialResponse?.(response);
    yield response;
  }

  private createContext(options: SseToChatJsonOptions): DecodeContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options,
      startTime: nowMs(),
      isCompleted: false,
      eventStats: {
        totalChunks: 0,
        totalTokens: 0,
        totalChoices: 0,
        totalToolCalls: 0,
        startTime: nowMs(),
        tokenRate: 0,
        chunkRate: 0,
        errorCount: 0,
        retryCount: 0
      }
    };
  }

  private async collectBodyText(
    source: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    context: DecodeContext
  ): Promise<string> {
    const chunks: string[] = [];
    const iterator = source[Symbol.asyncIterator]() as AsyncIterator<ChatSseEvent | string | Buffer>;
    while (true) {
      const next = await this.readNextStreamChunk(iterator, context);
      if (next.done) {
        break;
      }
      const value = next.value;
      const text = typeof value === 'string'
        ? value
        : Buffer.isBuffer(value)
          ? value.toString()
          : isChatSseEvent(value)
            ? eventToWire(value)
            : (() => {
                throw ErrorUtils.createError(
                  'Chat SSE decode requires wire string, Buffer, or ChatSseEvent chunks',
                  'CHAT_PARSE_ERROR',
                  { chunk: value }
                );
              })();
      chunks.push(text);
      this.updateStatsFromChunkText(context, text);
    }
    return chunks.join('');
  }

  private async readNextStreamChunk<T>(
    iterator: AsyncIterator<T>,
    context: DecodeContext
  ): Promise<IteratorResult<T>> {
    return this.raceWithTimeoutState(iterator.next(), context);
  }

  private updateStatsFromChunkText(context: DecodeContext, text: string): void {
    const now = nowMs();
    context.eventStats.totalChunks++;
    context.eventStats.firstFrameAtMs ??= now;
    context.eventStats.lastFrameAtMs = now;
    if (text.includes('"content"') || text.includes('"tool_calls"') || text.includes('"function_call"')) {
      context.eventStats.firstContentAtMs ??= now;
      context.eventStats.lastContentAtMs = now;
    }
  }

  private resolveTimeoutState(context: DecodeContext): {
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
    context: DecodeContext
  ): Promise<IteratorResult<T>> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutState = this.resolveTimeoutState(context);
    const remainingTimeoutMs = Math.max(1, timeoutState.anchorMs + Math.max(1, timeoutState.timeoutMs) - nowMs());
    try {
      return await Promise.race([
        pending,
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => reject(this.createSemanticTimeoutError(timeoutState)), remainingTimeoutMs);
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
  }): Error {
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

  private attachDecodeStats(response: ChatCompletionResponse, context: DecodeContext): void {
    Object.defineProperty(response, '__rccDecodeStats', {
      value: {
        chunkCount: context.eventStats.totalChunks,
        totalEvents: context.eventStats.totalChunks,
        contentBlocks: response.choices?.length ?? 0,
        firstFrameAtMs: context.eventStats.firstFrameAtMs,
        lastFrameAtMs: context.eventStats.lastFrameAtMs,
        firstContentAtMs: context.eventStats.firstContentAtMs,
        lastContentAtMs: context.eventStats.lastContentAtMs,
        totalTokens: response.usage?.total_tokens ?? 0
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }

  private wrapSseError(error: unknown, contextMessage: string): Error {
    const nativeProjected = parseNativeProjectedError(error);
    const wrapped = ErrorUtils.wrapError(error, contextMessage) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      requestExecutorProviderErrorStage?: string;
    };
    const source = nativeProjected ?? (error as Record<string, unknown> | undefined);
    const code = typeof source?.code === 'string' ? source.code : undefined;
    const statusCode =
      typeof source?.statusCode === 'number'
        ? source.statusCode
        : typeof source?.status === 'number'
          ? source.status
          : undefined;
    const retryable = typeof source?.retryable === 'boolean' ? source.retryable : undefined;
    const upstreamCode =
      typeof source?.upstreamCode === 'string'
        ? source.upstreamCode
        : code;
    if (code) {
      wrapped.code = code === 'CHAT_STREAM_ERROR' ? 'SSE_DECODE_ERROR' : code;
    } else if (
      wrapped.message.includes('Invalid SSE event type:')
      || wrapped.message.includes('Failed to parse Chat SSE frame JSON:')
      || wrapped.message.includes('Invalid chat_chunk payload')
    ) {
      wrapped.code = 'CHAT_PARSE_ERROR';
    }
    if (typeof statusCode === 'number') {
      wrapped.status = statusCode;
      wrapped.statusCode = statusCode;
    }
    if (typeof retryable === 'boolean') {
      wrapped.retryable = retryable;
    }
    if (upstreamCode) {
      wrapped.upstreamCode = upstreamCode;
    }
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }

  getStats(requestId: string): ChatEventStats | undefined {
    return this.stats.get(requestId);
  }

  cleanup(requestId: string): void {
    this.stats.delete(requestId);
  }

  cleanupAll(): void {
    this.stats.clear();
  }
}

export const defaultChatSseToJsonConverter = new ChatSseToJsonConverter();
