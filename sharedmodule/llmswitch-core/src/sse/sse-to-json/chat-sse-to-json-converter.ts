/**
 * Chat SSE -> JSON converter thin shell.
 * TS owns: stream IO collect, abort signal, error wrapping.
 * Rust owns: SSE decode semantics (frame parse, chunk aggregation, choice projection, usage normalization).
 */

// feature_id: sse.chat_stream_projection
import { buildChatJsonFromSseWithNative } from '../../native/router-hotpath/native-chat-sse-event-payload.js';
import type {
  ChatCompletionResponse,
  ChatSseEvent,
  SseToChatJsonOptions
} from '../types/index.js';

export class ChatSseToJsonConverter {
  async convertSseToJson(
    sseStream: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>,
    options: SseToChatJsonOptions
  ): Promise<ChatCompletionResponse> {
    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener('abort', () => {});
      abortHandler = () => abortSignal.removeEventListener('abort', () => {});
    }

    try {
      const bodyText = await this.collectBodyText(sseStream);

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

      options.onCompletion?.(response);
      return response;
    } catch (error) {
      options.onError?.(error as Error);
      throw this.wrapSseError(error, 'SSE to JSON conversion failed');
    } finally {
      if (abortHandler) abortHandler();
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
    source: AsyncIterable<ChatSseEvent> | AsyncIterable<string | Buffer>
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of source) {
      if (typeof chunk === 'string') {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk.toString());
      } else if (chunk && typeof (chunk as ChatSseEvent).event === 'string') {
        const event = chunk as ChatSseEvent;
        const lines: string[] = [];
        if (event.event && event.event !== 'chat_chunk') {
          lines.push(`event: ${event.event}`);
        }
        lines.push(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {})}`);
        chunks.push(`${lines.join('\n')}\n\n`);
      }
    }
    return chunks.join('');
  }

  private wrapSseError(error: unknown, contextMessage: string): Error {
    const original = error instanceof Error ? error : new Error(String(error ?? 'unknown'));
    const message = error && typeof error === 'object' && 'message' in (error as object)
      ? `${contextMessage}: ${(error as Error).message}`
      : contextMessage;
    const wrapped = new Error(message) as Error & { code?: string; upstreamCode?: string; status?: number; statusCode?: number; retryable?: boolean; requestExecutorProviderErrorStage?: string };
    wrapped.code = 'SSE_TO_JSON_ERROR';
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    // Preserve upstream error fields if the native error carries them
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      const msg = typeof err.message === 'string' ? err.message : '';
      // Native errors embed upstream codes in the message: "context_length_exceeded: ..."
      const knownCodes = ['context_length_exceeded', 'TERMINATED', 'UPSTREAM_STREAM_ERROR'];
      for (const known of knownCodes) {
        if (msg.includes(known) || msg === known) {
          wrapped.code = known;
          wrapped.upstreamCode = known;
          if (known === 'context_length_exceeded') {
            wrapped.status = 400;
            wrapped.statusCode = 400;
          }
          break;
        }
      }
      if (typeof err.code === 'string' && err.code !== 'SSE_TO_JSON_ERROR') {
        wrapped.upstreamCode = err.code;
        wrapped.code = err.code;
      }
      if (typeof err.status === 'number') wrapped.status = err.status;
      if (typeof err.statusCode === 'number') wrapped.statusCode = err.statusCode;
      if (typeof err.retryable === 'boolean') wrapped.retryable = err.retryable;
      if (typeof err.upstreamCode === 'string') wrapped.upstreamCode = err.upstreamCode;
    }
    return wrapped;
  }
}
