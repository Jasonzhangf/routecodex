import {
  normalizeMessageContentPartsWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

type UnknownRecord = Record<string, unknown>;

function assertOutputContentNormalizerNativeAvailable(): void {
  if (
    typeof normalizeMessageContentPartsWithNative !== 'function'
  ) {
    throw new Error('[output-content-normalizer] native bindings unavailable');
  }
}

export function normalizeMessageContentParts(parts: unknown, reasoningCollector?: string[]): {
  normalizedParts: UnknownRecord[];
  reasoningChunks: string[];
} {
  assertOutputContentNormalizerNativeAvailable();
  const normalized = normalizeMessageContentPartsWithNative(parts, reasoningCollector ?? []);
  if (reasoningCollector) {
    reasoningCollector.splice(0, reasoningCollector.length, ...normalized.reasoningChunks);
  }
  return normalized;
}
