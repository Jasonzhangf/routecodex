/**
 * Responses SSE -> JSON converter thin shell.
 * TS owns: stream IO collect, abort signal, error wrapping, stats attachment.
 * Rust owns: SSE decode semantics (event parsing, output accumulation, function_call delta, status synthesis).
 */

// feature_id: sse.responses_decode_projection
import { Readable } from 'stream';
import type {
  ResponsesResponse,
  ResponsesSseEvent,
  SseToResponsesJsonOptions,
  ResponsesSseEventStream
} from '../types/index.js';
import { buildResponsesJsonFromSseJsonWithNative } from '../../native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.js';

const TOTAL_TIMEOUT_MS = 300_000;

export class ResponsesSseToJsonConverterRefactored {
  async convertSseToJson(
    sseStream: ResponsesSseEventStream | Readable | AsyncIterable<string | Buffer>,
    options: Partial<SseToResponsesJsonOptions> = {}
  ): Promise<ResponsesResponse> {
    const requestId = typeof options.requestId === 'string' && options.requestId.trim()
      ? options.requestId.trim()
      : 'responses-sse-decode';
    const model = options.model ?? '';

    const abortSignal = options.abortSignal;
    let abortHandler: (() => void) | null = null;
    const rawChunks: string[] = [];

    try {
      const readableStream = this.createReadableStream(sseStream);
      const totalTimeout = this.createTotalTimeout(requestId);

      if (abortSignal && !abortSignal.aborted) {
        const onAbort = () => readableStream?.destroy();
        abortSignal.addEventListener('abort', onAbort);
        abortHandler = () => abortSignal.removeEventListener('abort', onAbort);
      }

      for await (const chunk of this.captureChunkStrings(readableStream, rawChunks)) {
        if (options.onEvent && typeof (chunk as unknown as ResponsesSseEvent).type === 'string') {
          options.onEvent(chunk as unknown as ResponsesSseEvent);
        }
      }
      clearTimeout(totalTimeout);

      if (abortSignal?.aborted) {
        const reason = (abortSignal as { reason?: unknown }).reason;
        const err = reason instanceof Error ? reason : new Error(String(reason ?? 'CLIENT_DISCONNECTED'));
        Object.assign(err, { code: 'CLIENT_DISCONNECTED', name: 'AbortError' });
        throw err;
      }

      const response = buildResponsesJsonFromSseJsonWithNative({
        bodyText: rawChunks.join('')
      }) as unknown as ResponsesResponse;

      options.onCompletion?.(response);
      return response;
    } catch (error) {
      throw this.wrapError('SSE_TO_JSON_ERROR', error as Error, requestId);
    } finally {
      if (abortHandler) abortHandler();
    }
  }

  private createTotalTimeout(requestId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      throw Object.assign(new Error(`SSE decode total timeout (${TOTAL_TIMEOUT_MS}ms)`), {
        code: 'SSE_DECODE_TIMEOUT',
        requestExecutorProviderErrorStage: 'provider.sse_decode'
      });
    }, TOTAL_TIMEOUT_MS);
  }

  private createReadableStream(sseStream: ResponsesSseEventStream | Readable | AsyncIterable<string | Buffer>): Readable {
    if (sseStream instanceof Readable) {
      return sseStream;
    }
    return Readable.from(this.convertAsyncIterableToStream(sseStream));
  }

  private async *convertAsyncIterableToStream(sseStream: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
    for await (const chunk of sseStream) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        yield Buffer.isBuffer(chunk) ? chunk : (chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk));
      } else {
        throw new Error('Responses SSE decode requires wire string, Buffer, or Uint8Array chunks');
      }
    }
  }

  private async *captureChunkStrings(
    stream: Readable,
    rawChunks: string[]
  ): AsyncGenerator<string> {
    for await (const chunk of stream) {
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString()
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : (() => { throw new Error('Responses SSE decode requires wire string, Buffer, or Uint8Array chunks'); })();
      rawChunks.push(text);
      yield text;
    }
  }

  private wrapError(code: string, originalError: Error, requestId: string): Error {
    const error = new Error(`${code}: ${originalError.message}`) as Error & {
      code?: string;
      requestExecutorProviderErrorStage?: string;
    };
    error.code = code;
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return error;
  }
}

export const ResponsesSseToJsonConverter = ResponsesSseToJsonConverterRefactored;
