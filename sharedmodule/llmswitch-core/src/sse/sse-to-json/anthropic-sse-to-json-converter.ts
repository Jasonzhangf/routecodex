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
      for await (const result of parser.parseStreamAsync(this.chunkStrings(sseStream))) {
        if (!result.success || !result.event) {
          if (this.config.strictMode) {
            throw new Error(result.error || 'Failed to parse Anthropic SSE event');
          }
          continue;
        }

        const upstreamError = this.extractAnthropicErrorEventMessage(result.event);
        if (upstreamError) {
          throw new Error(upstreamError);
        }

        if ((result.event as AnthropicSseEvent).protocol !== 'anthropic-messages') {
          continue;
        }
        builder.processEvent(result.event as AnthropicSseEvent);
        this.updateStats(context, result.event as AnthropicSseEvent);
      }

      const outcome = builder.getResult();
      if (!outcome.success || !outcome.response) {
        throw outcome.error || new Error('Anthropic SSE conversion incomplete');
      }
      context.isCompleted = true;
      context.eventStats.endTime = Date.now();
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
    if (typeof message !== 'string') {
      return false;
    }
    const normalized = message.toLowerCase();
    return (
      normalized.includes('terminated') ||
      normalized.includes('upstream_stream_idle_timeout') ||
      normalized.includes('upstream_stream_timeout')
    );
  }

  private createContext(options: SseToAnthropicJsonOptions): SseToAnthropicJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      startTime: Date.now(),
      eventStats: {
        totalEvents: 0,
        contentBlocks: 0,
        toolUseBlocks: 0,
        thinkingBlocks: 0,
        textBlocks: 0,
        errors: 0,
        startTime: Date.now()
      },
      isCompleted: false
    };
  }

  private async *chunkStrings(stream: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
    for await (const chunk of stream) {
      yield typeof chunk === 'string' ? chunk : chunk.toString();
    }
  }

  private updateStats(context: SseToAnthropicJsonContext, event: AnthropicSseEvent): void {
    context.eventStats.totalEvents += 1;
    if (event.type === 'content_block_start') {
      context.eventStats.contentBlocks += 1;
      const blockType = (event.data as any)?.content_block?.type;
      if (blockType === 'tool_use') context.eventStats.toolUseBlocks += 1;
      if (blockType === 'thinking') context.eventStats.thinkingBlocks += 1;
      if (blockType === 'text') context.eventStats.textBlocks += 1;
    }
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
    return ErrorUtils.createError(error.message, code, { requestId });
  }
}
