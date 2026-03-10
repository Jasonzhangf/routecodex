import type {
  ProcessedRequest,
  StandardizedRequest
} from '../../conversion/hub/types/standardized.js';
import { countRequestTokens } from './token-counter.js';

export function computeRequestTokens(request: StandardizedRequest | ProcessedRequest, fallbackText: string): number {
  try {
    return countRequestTokens(request as StandardizedRequest);
  } catch {
    return fallbackEstimateTokens(fallbackText, request.messages?.length ?? 0);
  }
}

function fallbackEstimateTokens(text: string, messageCount: number): number {
  if (!text) {
    return Math.max(32, Math.max(messageCount, 1) * 16);
  }
  const rough = Math.ceil(text.length / 4);
  return Math.max(rough, Math.max(messageCount, 1) * 32);
}
