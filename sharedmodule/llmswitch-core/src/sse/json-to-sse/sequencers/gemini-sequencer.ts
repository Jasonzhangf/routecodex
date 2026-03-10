import type {
  GeminiResponse,
  GeminiSseEvent,
  GeminiChunkEventData,
  GeminiDoneEventData,
  GeminiContentPart,
  GeminiCandidate
} from '../../types/index.js';
import type { ChatReasoningMode } from '../../types/chat-types.js';
import { dispatchReasoning } from '../../shared/reasoning-dispatcher.js';

export interface GeminiSequencerConfig {
  chunkDelayMs: number;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

const DEFAULT_CONFIG: GeminiSequencerConfig = {
  chunkDelayMs: 0,
  reasoningMode: 'channel',
  reasoningTextPrefix: undefined
};

function createEvent(type: GeminiSseEvent['type'], data: GeminiChunkEventData | GeminiDoneEventData): GeminiSseEvent {
  return {
    type,
    event: type,
    protocol: 'gemini-chat',
    direction: 'json_to_sse',
    timestamp: Date.now(),
    data,
    sequenceNumber: 0
  };
}

async function maybeDelay(config: GeminiSequencerConfig): Promise<void> {
  if (!config.chunkDelayMs) return;
  await new Promise((resolve) => setTimeout(resolve, config.chunkDelayMs));
}

function getCandidateRole(candidate: GeminiCandidate, fallback = 'model'): string {
  const role = candidate?.content?.role;
  if (typeof role === 'string' && role.trim().length) {
    return role;
  }
  return fallback;
}

function getCandidateParts(candidate: GeminiCandidate): GeminiContentPart[] {
  const parts = candidate?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((part): part is GeminiContentPart => Boolean(part));
  }
  return [];
}

export function createGeminiSequencer(config?: Partial<GeminiSequencerConfig>) {
  const finalConfig: GeminiSequencerConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    async *sequenceResponse(response: GeminiResponse): AsyncGenerator<GeminiSseEvent> {
      const candidates = Array.isArray(response.candidates) ? response.candidates : [];
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex] || {};
        const role = getCandidateRole(candidate);
        const parts = getCandidateParts(candidate);
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
          const normalizedParts = normalizeReasoningPart(parts[partIndex], finalConfig);
          for (const normalizedPart of normalizedParts) {
            yield createEvent('gemini.data', {
              kind: 'part',
              candidateIndex,
              partIndex,
              role,
              part: normalizedPart
            });
            await maybeDelay(finalConfig);
          }
        }
      }

      const doneData: GeminiDoneEventData = {
        kind: 'done',
        usageMetadata: response.usageMetadata,
        promptFeedback: response.promptFeedback,
        modelVersion: response.modelVersion,
        candidates: candidates.map((candidate, index) => ({
          index,
          finishReason: candidate?.finishReason,
          safetyRatings: candidate?.safetyRatings
        }))
      };
      yield createEvent('gemini.done', doneData);
    }
  };
}

function normalizeReasoningPart(
  part: GeminiContentPart,
  config: GeminiSequencerConfig
): GeminiContentPart[] {
  if (!part || typeof part !== 'object') {
    return [part];
  }
  const reasoning = typeof (part as any).reasoning === 'string' ? (part as any).reasoning : undefined;
  if (!reasoning) {
    return [part];
  }
  const decision = dispatchReasoning(reasoning, {
    mode: config.reasoningMode,
    prefix: config.reasoningTextPrefix
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
