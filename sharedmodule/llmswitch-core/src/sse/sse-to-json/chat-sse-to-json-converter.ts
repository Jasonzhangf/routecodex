/**
 * Chat SSE -> JSON converter thin shell.
 * TS owns: stream IO collect, abort signal, total timeout, error wrapping, stats.
 * Rust owns: SSE decode semantics (frame parse, chunk aggregation, choice projection, usage normalization).
 */

// feature_id: sse.chat_stream_projection
import { ErrorUtils } from '../shared/utils.js';
import { buildChatJsonFromSseWithNative } from '../../native/router-hotpath/native-chat-sse-event-payload.js';
import type {
  ChatCompletionResponse,
  ChatSseEvent,
  SseToChatJsonOptions,
  ChatEventStats
} from '../types/index.js';

const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

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

export class ChatSseToJsonConverter {
  private readonly stats = new Map<string, DecodeContext>();

  async convertSseToJson(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): Promise<ChatCompletionResponse> {
    const context: DecodeContext = {
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
    this.stats.set(options.requestId, context);

    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    if (abortSignal && !abortSignal.aborted) {
      const onAbort = () => { context.isCompleted = true; };
      abortSignal.addEventListener('abort', onAbort);
      abortHandler = () => abortSignal.removeEventListener('abort', onAbort);
    }

    try {
      // TS collects stream chunks as wire strings; Rust does decode
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
      return response;
    } catch (error) {
      context.eventStats.errorCount++;
      options.onError?.(error as Error);
      throw this.wrapSseError(error, 'SSE to JSON conversion failed');
    } finally {
      abortHandler?.();
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

  private async collectBodyText(
    source: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    context: DecodeContext
  ): Promise<string> {
    const chunks: string[] = [];
    const iterator = source[Symbol.asyncIterator]() as AsyncIterator<ChatSseEvent | string | Buffer>;

    // Total timeout guard
    const deadline = nowMs() + DEFAULT_TOTAL_TIMEOUT_MS;

    while (true) {
      const remaining = deadline - nowMs();
      if (remaining <= 0) {
        throw this.makeTimeoutError('UPSTREAM_STREAM_TOTAL_TIMEOUT', DEFAULT_TOTAL_TIMEOUT_MS);
      }
      let timer: NodeJS.Timeout | null = null;
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<ChatSseEvent | string | Buffer>>((_, reject) => {
          timer = setTimeout(() => reject(this.makeTimeoutError('UPSTREAM_STREAM_TOTAL_TIMEOUT', remaining)), remaining);
          timer.unref?.();
        })
      ]);
      if (timer) clearTimeout(timer);
      if (next.done) break;

      const value = next.value;
      const text = typeof value === 'string'
        ? value
        : Buffer.isBuffer(value)
          ? value.toString()
          : isChatSseEvent(value)
            ? eventToWire(value)
            : (() => { throw ErrorUtils.createError('Chat SSE decode requires wire string, Buffer, or ChatSseEvent chunks', 'CHAT_PARSE_ERROR', { chunk: value }); })();
      chunks.push(text);
      this.updateStatsFromChunkText(context, text);
    }
    return chunks.join('');
  }

  private makeTimeoutError(code: string, timeoutMs: number): Error {
    const error = new Error(`Upstream stream timeout: no complete frame within ${timeoutMs}ms`) as Error & { code: string };
    error.code = code;
    return error;
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

  private wrapSseError(error: unknown, contextMessage: string): Error {
    const message = error instanceof Error ? error.message : String(error ?? '');

    // Try to parse native projected payload from error message (original behavior)
    function parseNativeProjectedError(error: unknown): Record<string, unknown> | null {
      const msg = error instanceof Error ? error.message : String(error ?? '');
      try {
        const parsed = JSON.parse(msg);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    }

    const nativeProjected = parseNativeProjectedError(error);
    const source = nativeProjected ?? (error instanceof Error ? (error as unknown as Record<string, unknown>) : undefined);

    // Extract error code: prefer parsed JSON, then native error.code, then SSE parse heuristic
    let code: string | undefined;
    if (typeof source?.code === 'string' && source.code) {
      code = source.code === 'CHAT_STREAM_ERROR' ? 'SSE_DECODE_ERROR' : source.code;
    } else if (
      message.includes('Invalid SSE event type:')
      || message.includes('Failed to parse Chat SSE frame JSON:')
      || message.includes('Invalid chat_chunk payload')
    ) {
      code = 'CHAT_PARSE_ERROR';
    }

    const wrapped = ErrorUtils.wrapError(error, contextMessage) as Error & {
      code?: string; status?: number; statusCode?: number;
      upstreamCode?: string; retryable?: boolean;
      requestExecutorProviderErrorStage?: string
    };
    if (code) wrapped.code = code;
    if (source) {
      wrapped.status = typeof source.statusCode === 'number' ? source.statusCode : (typeof source.status === 'number' ? source.status : 504);
      wrapped.statusCode = typeof source.statusCode === 'number' ? source.statusCode : wrapped.status;
      const upstream = typeof source.upstreamCode === 'string' ? source.upstreamCode : code;
      if (upstream) wrapped.upstreamCode = upstream;
      if (typeof source.retryable === 'boolean') wrapped.retryable = source.retryable;
    }
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }

  getStats(requestId: string): ChatEventStats | undefined {
    return this.stats.get(requestId)?.eventStats;
  }

  cleanup(requestId: string): void {
    this.stats.delete(requestId);
  }

  cleanupAll(): void {
    this.stats.clear();
  }
}

export const defaultChatSseToJsonConverter = new ChatSseToJsonConverter();
