import { PassThrough } from 'node:stream';
import { DEFAULT_GEMINI_CONVERSION_CONFIG } from '../types/index.js';
import type {
  GeminiResponse,
  GeminiJsonToSseOptions,
  GeminiJsonToSseContext,
  GeminiEventStats
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createGeminiSequencer } from './sequencers/gemini-sequencer.js';
import { createGeminiStreamWriter } from '../shared/writer.js';

export class GeminiJsonToSseConverter {
  private config = DEFAULT_GEMINI_CONVERSION_CONFIG;
  private contexts = new Map<string, GeminiJsonToSseContext>();

  constructor(config?: Partial<typeof DEFAULT_GEMINI_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async convertResponseToJsonToSse(
    response: GeminiResponse,
    options: GeminiJsonToSseOptions
  ): Promise<PassThrough> {
    const context = this.createContext(response, options);
    this.contexts.set(options.requestId, context);

    const stream = new PassThrough({ objectMode: true });
    const writer = createGeminiStreamWriter(stream, {
      onEvent: () => this.updateStats(context, 'chunk'),
      onError: (error) => this.handleStreamError(context, error, stream)
    });

    this.processResponse(response, context, writer, stream).catch((error) => {
      this.handleStreamError(context, error as Error, stream);
    });

    return Object.assign(stream, {
      protocol: 'gemini-chat' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => context.eventStats,
      complete: () => writer.complete(),
      abort: (error?: Error) => writer.abort(error)
    });
  }

  private createContext(
    response: GeminiResponse,
    options: GeminiJsonToSseOptions
  ): GeminiJsonToSseContext {
    const stats: GeminiEventStats = {
      totalEvents: 0,
      chunkEvents: 0,
      doneEvents: 0,
      errors: 0,
      startTime: Date.now()
    };
    return {
      requestId: options.requestId,
      model: options.model,
      response,
      options,
      startTime: Date.now(),
      eventStats: stats
    };
  }

  private async processResponse(
    response: GeminiResponse,
    context: GeminiJsonToSseContext,
    writer: ReturnType<typeof createGeminiStreamWriter>,
    stream: PassThrough
  ): Promise<void> {
    try {
      this.validateResponse(response);
      const sequencer = createGeminiSequencer({
        chunkDelayMs: context.options.chunkDelayMs ?? this.config.chunkDelayMs,
        reasoningMode: context.options.reasoningMode ?? this.config.reasoningMode,
        reasoningTextPrefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
      });
      const events = sequencer.sequenceResponse(response);
      await writer.writeGeminiEvents(events);
      this.updateStats(context, 'done');
      writer.complete();
    } catch (error) {
      writer.abort(error as Error);
      throw this.wrapError('GEMINI_JSON_TO_SSE_FAILED', error as Error, context.requestId);
    } finally {
      this.contexts.delete(context.requestId);
      stream.end();
    }
  }

  private validateResponse(response: GeminiResponse): void {
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid Gemini response payload');
    }
  }

  private updateStats(context: GeminiJsonToSseContext, kind: 'chunk' | 'done'): void {
    context.eventStats.totalEvents += 1;
    if (kind === 'chunk') {
      context.eventStats.chunkEvents += 1;
    } else {
      context.eventStats.doneEvents += 1;
    }
  }

  private handleStreamError(
    context: GeminiJsonToSseContext,
    error: Error,
    stream: PassThrough
  ): void {
    context.eventStats.errors += 1;
    try {
      stream.destroy(error);
    } catch {
      /* ignore */
    }
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    return ErrorUtils.createError(error.message, code, { requestId });
  }
}
