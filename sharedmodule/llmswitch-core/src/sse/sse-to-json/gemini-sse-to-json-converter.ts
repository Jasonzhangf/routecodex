/**
 * Gemini SSE -> JSON converter thin shell.
 * TS owns: stream IO collect, error wrapping.
 * Rust owns: SSE decode semantics (frame parse, candidate aggregation, part normalization).
 */

// feature_id: sse.anthropic_gemini_stream_projection
import { buildGeminiJsonFromSseWithNative } from '../../native/router-hotpath/native-gemini-sse-event-payload.js';
import type { GeminiResponse, SseToGeminiJsonOptions } from '../types/index.js';

export class GeminiSseToJsonConverter {
  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToGeminiJsonOptions
  ): Promise<GeminiResponse> {
    try {
      const bodyText = await this.collectBodyText(sseStream);
      const response = buildGeminiJsonFromSseWithNative({
        bodyText,
        requestId: options.requestId,
        model: options.model,
        config: {
          reasoningMode: options.reasoningMode,
          reasoningTextPrefix: options.reasoningTextPrefix
        }
      }) as unknown as GeminiResponse;
      return response;
    } catch (error) {
      throw this.wrapError('GEMINI_SSE_TO_JSON_FAILED', error as Error, options.requestId);
    }
  }

  private async collectBodyText(
    source: AsyncIterable<string | Buffer>
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of source) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    }
    return chunks.join('');
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    const wrapped = new Error(`${code}: ${error.message}`) as Error & { code?: string; requestExecutorProviderErrorStage?: string };
    wrapped.code = code;
    wrapped.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return wrapped;
  }
}
