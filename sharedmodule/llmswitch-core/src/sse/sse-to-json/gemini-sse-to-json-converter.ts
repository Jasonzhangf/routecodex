// feature_id: sse.anthropic_gemini_stream_projection
import type {
  GeminiResponse,
  SseToGeminiJsonOptions,
  SseToGeminiJsonContext
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { buildGeminiJsonFromSseWithNative } from '../../native/router-hotpath/native-gemini-sse-event-payload.js';

export class GeminiSseToJsonConverter {
  private contexts = new Map<string, SseToGeminiJsonContext>();

  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToGeminiJsonOptions
  ): Promise<GeminiResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    try {
      const bodyText = await this.collectBodyText(sseStream, context);
      const response = buildGeminiJsonFromSseWithNative({
        bodyText,
        requestId: options.requestId,
        model: options.model,
        config: {
          reasoningMode: options.reasoningMode,
          reasoningTextPrefix: options.reasoningTextPrefix
        }
      }) as unknown as GeminiResponse;
      context.isCompleted = true;
      context.eventStats.endTime = Date.now();
      return response;
    } catch (error) {
      context.eventStats.errors += 1;
      throw this.wrapError('GEMINI_SSE_TO_JSON_FAILED', error as Error, options.requestId);
    } finally {
      this.contexts.delete(options.requestId);
    }
  }

  private async collectBodyText(
    stream: AsyncIterable<string | Buffer>,
    context: SseToGeminiJsonContext
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of stream) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      context.eventStats.chunkEvents += 1;
      context.eventStats.totalEvents += 1;
      chunks.push(text);
    }
    return chunks.join('');
  }

  private createContext(options: SseToGeminiJsonOptions): SseToGeminiJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options: {
        reasoningMode: options.reasoningMode,
        reasoningTextPrefix: options.reasoningTextPrefix
      },
      startTime: Date.now(),
      eventStats: {
        totalEvents: 0,
        chunkEvents: 0,
        doneEvents: 0,
        errors: 0,
        startTime: Date.now()
      },
      isCompleted: false
    };
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    return ErrorUtils.createError(error.message, code, { requestId });
  }
}
