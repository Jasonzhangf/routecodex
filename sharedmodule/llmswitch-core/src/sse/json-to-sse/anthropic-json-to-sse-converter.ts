import { PassThrough } from 'node:stream';
import { DEFAULT_ANTHROPIC_CONVERSION_CONFIG } from '../types/index.js';
import type {
  AnthropicMessageResponse,
  AnthropicJsonToSseOptions,
  AnthropicJsonToSseContext,
  AnthropicEventStats
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { createAnthropicSequencer } from './sequencers/anthropic-sequencer.js';
import { createAnthropicStreamWriter } from '../shared/writer.js';

export class AnthropicJsonToSseConverter {
  private config = DEFAULT_ANTHROPIC_CONVERSION_CONFIG;
  private contexts = new Map<string, AnthropicJsonToSseContext>();

  constructor(config?: Partial<typeof DEFAULT_ANTHROPIC_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async convertResponseToJsonToSse(
    response: AnthropicMessageResponse,
    options: AnthropicJsonToSseOptions
  ): Promise<PassThrough> {
    const context = this.createContext(response, options);
    this.contexts.set(options.requestId, context);
    const stream = new PassThrough({ objectMode: true });
    const writer = createAnthropicStreamWriter(stream, {
      onEvent: (event) => this.updateStats(context, event as any),
      onError: (error) => this.handleStreamError(context, error, stream)
    });

    this.processResponse(response, context, writer, stream).catch((error) => {
      this.handleStreamError(context, error as Error, stream);
    });

    return Object.assign(stream, {
      protocol: 'anthropic-messages' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => context.eventStats,
      complete: () => writer.complete(),
      abort: (error?: Error) => writer.abort(error)
    });
  }

  private createContext(
    response: AnthropicMessageResponse,
    options: AnthropicJsonToSseOptions
  ): AnthropicJsonToSseContext {
    const stats: AnthropicEventStats = {
      totalEvents: 0,
      contentBlocks: 0,
      toolUseBlocks: 0,
      thinkingBlocks: 0,
      textBlocks: 0,
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
    response: AnthropicMessageResponse,
    context: AnthropicJsonToSseContext,
    writer: ReturnType<typeof createAnthropicStreamWriter>,
    stream: PassThrough
  ): Promise<void> {
    try {
      this.validateResponse(response);
      const sequencer = createAnthropicSequencer({
        chunkSize: context.options.chunkSize ?? this.config.defaultChunkSize,
        chunkDelayMs: context.options.chunkDelayMs ?? this.config.defaultDelayMs,
        enableDelay: Boolean(context.options.chunkDelayMs),
        reasoningMode: context.options.reasoningMode ?? this.config.reasoningMode,
        reasoningTextPrefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
      });
      const events = sequencer.sequenceResponse(response, context.requestId);
      await writer.writeAnthropicEvents(events);
      writer.complete();
    } catch (error) {
      writer.abort(error as Error);
      throw this.wrapError('ANTHROPIC_JSON_TO_SSE_FAILED', error as Error, context.requestId);
    } finally {
      this.contexts.delete(context.requestId);
      stream.end();
    }
  }

  private updateStats(context: AnthropicJsonToSseContext, event: unknown): void {
    context.eventStats.totalEvents += 1;
    if (!event || typeof event !== 'object') return;
    const type = (event as any).type;
    if (type === 'content_block_start') {
      context.eventStats.contentBlocks += 1;
      const blockType = (event as any).data?.content_block?.type;
      if (blockType === 'tool_use') context.eventStats.toolUseBlocks += 1;
      if (blockType === 'thinking') context.eventStats.thinkingBlocks += 1;
      if (blockType === 'text') context.eventStats.textBlocks += 1;
    }
  }

  private validateResponse(response: AnthropicMessageResponse): void {
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid Anthropic response payload');
    }
    if (!Array.isArray(response.content)) {
      throw new Error('Anthropic response content must be an array');
    }
  }

  private handleStreamError(
    context: AnthropicJsonToSseContext,
    error: Error,
    stream: PassThrough
  ): void {
    context.eventStats.errors += 1;
    try {
      stream.destroy(error);
    } catch {
      /* noop */
    }
  }

  private wrapError(code: string, error: Error, requestId: string): Error {
    return ErrorUtils.createError(error.message, code, { requestId });
  }
}
