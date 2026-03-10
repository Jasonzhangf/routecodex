import { DEFAULT_GEMINI_CONVERSION_CONFIG } from '../types/index.js';
import type {
  GeminiResponse,
  GeminiCandidate,
  GeminiContentPart,
  GeminiSseEvent,
  SseToGeminiJsonOptions,
  SseToGeminiJsonContext
} from '../types/index.js';
import { ErrorUtils } from '../shared/utils.js';
import { dispatchReasoning } from '../shared/reasoning-dispatcher.js';
import { createSseParser } from './parsers/sse-parser.js';

type CandidateAccumulator = {
  role: string;
  parts: GeminiContentPart[];
};

export class GeminiSseToJsonConverter {
  private config = DEFAULT_GEMINI_CONVERSION_CONFIG;
  private contexts = new Map<string, SseToGeminiJsonContext>();

  constructor(config?: Partial<typeof DEFAULT_GEMINI_CONVERSION_CONFIG>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async convertSseToJson(
    sseStream: AsyncIterable<string | Buffer>,
    options: SseToGeminiJsonOptions
  ): Promise<GeminiResponse> {
    const context = this.createContext(options);
    this.contexts.set(options.requestId, context);

    const parser = createSseParser({
      enableStrictValidation: true,
      enableEventRecovery: true,
      allowedEventTypes: new Set([
        'gemini.data',
        'gemini.done'
      ])
    });

    const accumulator = new Map<number, CandidateAccumulator>();
    let donePayload: any = null;

    try {
      for await (const result of parser.parseStreamAsync(this.normalizeStream(sseStream))) {
        if (!result.success || !result.event) {
          if (result.error) {
            throw new Error(result.error);
          }
          continue;
        }
        const event = result.event as GeminiSseEvent;
        if (event.protocol !== 'gemini-chat') continue;

        if (event.type === 'gemini.data') {
          this.processChunkEvent(event, accumulator, context);
          context.eventStats.chunkEvents += 1;
        } else if (event.type === 'gemini.done') {
          donePayload = event.data;
          context.eventStats.doneEvents += 1;
        }
        context.eventStats.totalEvents += 1;
      }

      if (!donePayload) {
        throw new Error('Gemini SSE stream missing done event');
      }

      const response = this.buildResponse(accumulator, donePayload);
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

  private processChunkEvent(
    event: GeminiSseEvent,
    accumulator: Map<number, CandidateAccumulator>,
    context: SseToGeminiJsonContext
  ): void {
    const payload = event.data as { candidateIndex?: number; role?: string; part?: GeminiContentPart };
    const candidateIndex = typeof payload?.candidateIndex === 'number' ? payload.candidateIndex : 0;
    const part = payload?.part;
    if (!part) return;
    const role = typeof payload?.role === 'string' ? payload.role : 'model';
    if (!accumulator.has(candidateIndex)) {
      accumulator.set(candidateIndex, { role, parts: [] });
    }

    const candidate = accumulator.get(candidateIndex)!;
    const normalizedParts = this.normalizeReasoningPart(part, context);

    for (const normalizedPart of normalizedParts) {
      // For text parts, accumulate into the last text part instead of creating new ones
      if ('text' in normalizedPart && typeof normalizedPart.text === 'string') {
        const lastPart = candidate.parts[candidate.parts.length - 1];
        if (lastPart && 'text' in lastPart && typeof lastPart.text === 'string') {
          // Append to existing text part
          lastPart.text += normalizedPart.text;
        } else {
          // Create new text part
          candidate.parts.push(normalizedPart);
        }
      } else if ('reasoning' in normalizedPart && typeof normalizedPart.reasoning === 'string') {
        // For reasoning parts, also accumulate
        const lastPart = candidate.parts[candidate.parts.length - 1];
        if (lastPart && 'reasoning' in lastPart && typeof (lastPart as any).reasoning === 'string') {
          (lastPart as any).reasoning += (normalizedPart as any).reasoning;
        } else {
          candidate.parts.push(normalizedPart);
        }
      } else {
        // For other part types (functionCall, functionResponse, etc.), add as separate parts
        candidate.parts.push(normalizedPart);
      }
    }
  }

  private buildResponse(
    accumulator: Map<number, CandidateAccumulator>,
    donePayload: any
  ): GeminiResponse {
    const candidates: GeminiCandidate[] = [];
    const candidateMeta: Record<number, { finishReason?: string; safetyRatings?: unknown[] }> = {};
    if (Array.isArray(donePayload?.candidates)) {
      for (const entry of donePayload.candidates) {
        if (!entry || typeof entry.index !== 'number') continue;
        candidateMeta[entry.index] = {
          finishReason: entry.finishReason,
          safetyRatings: entry.safetyRatings
        };
      }
    }
    const indices = Array.from(accumulator.keys()).sort((a, b) => a - b);
    for (const index of indices) {
      const acc = accumulator.get(index);
      if (!acc) continue;
      candidates.push({
        content: {
          role: acc.role,
          parts: acc.parts
        },
        finishReason: candidateMeta[index]?.finishReason,
        safetyRatings: candidateMeta[index]?.safetyRatings
      });
    }
    return {
      candidates,
      promptFeedback: donePayload?.promptFeedback,
      usageMetadata: donePayload?.usageMetadata,
      modelVersion: donePayload?.modelVersion
    };
  }

  private async *normalizeStream(stream: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
    for await (const chunk of stream) {
      yield typeof chunk === 'string' ? chunk : chunk.toString();
    }
  }

  private createContext(options: SseToGeminiJsonOptions): SseToGeminiJsonContext {
    return {
      requestId: options.requestId,
      model: options.model,
      options: {
        reasoningMode: options.reasoningMode ?? this.config.reasoningMode,
        reasoningTextPrefix: options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
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

  private normalizeReasoningPart(
    part: GeminiContentPart,
    context: SseToGeminiJsonContext
  ): GeminiContentPart[] {
    if (!part || typeof part !== 'object') {
      return [part];
    }
    const reasoning = typeof (part as any).reasoning === 'string' ? (part as any).reasoning : undefined;
    if (!reasoning) {
      return [part];
    }
    const decision = dispatchReasoning(reasoning, {
      mode: context.options.reasoningMode ?? this.config.reasoningMode,
      prefix: context.options.reasoningTextPrefix ?? this.config.reasoningTextPrefix
    });
    const normalized: GeminiContentPart[] = [];
    if (decision.appendToContent) {
      normalized.push({ text: decision.appendToContent });
    }
    if (decision.channel) {
      normalized.push({ reasoning: decision.channel } as Record<string, unknown>);
    }
    return normalized;
  }
}
