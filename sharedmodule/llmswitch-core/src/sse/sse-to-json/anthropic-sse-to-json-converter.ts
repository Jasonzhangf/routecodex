/**
 * Anthropic SSE -> JSON converter thin shell.
 * TS owns: stream IO collect, abort signal, error wrapping.
 * Rust owns: SSE decode semantics (event parsing, content accumulation, tool_use dedup).
 */

// feature_id: sse.anthropic_gemini_stream_projection
import { buildAnthropicJsonFromSseWithNative } from '../../native/router-hotpath/native-anthropic-sse-event-payload.js';
import type {
  AnthropicMessageResponse,
  SseToAnthropicJsonOptions
} from '../types/index.js';

export class AnthropicSseToJsonConverter {
  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToAnthropicJsonOptions
  ): Promise<AnthropicMessageResponse> {
    try {
      const bodyText = await this.collectBodyText(sseStream);
      const response = buildAnthropicJsonFromSseWithNative({
        bodyText,
        requestId: options.requestId,
        model: options.model,
        config: {
          reasoningMode: options.reasoningMode,
          reasoningTextPrefix: options.reasoningTextPrefix
        }
      }) as unknown as AnthropicMessageResponse;
      return response;
    } catch (error) {
      throw this.wrapError('ANTHROPIC_SSE_TO_JSON_FAILED', error as Error, options.requestId);
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
