import {
  extractOutputSegmentsWithNative,
  normalizeContentPartWithNative,
  normalizeMessageContentPartsWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type UnknownRecord = Record<string, unknown>;

function assertOutputContentNormalizerNativeAvailable(): void {
  if (
    typeof extractOutputSegmentsWithNative !== 'function' ||
    typeof normalizeContentPartWithNative !== 'function' ||
    typeof normalizeMessageContentPartsWithNative !== 'function'
  ) {
    throw new Error('[output-content-normalizer] native bindings unavailable');
  }
}

export interface OutputContentExtractionResult {
  textParts: string[];
  reasoningParts: string[];
}

export function extractOutputSegments(source: UnknownRecord | undefined, itemsKey: string = 'output'): OutputContentExtractionResult {
  assertOutputContentNormalizerNativeAvailable();
  return extractOutputSegmentsWithNative(source, itemsKey);
}

export function normalizeContentPart(part: unknown, reasoningCollector: string[]): UnknownRecord | null {
  assertOutputContentNormalizerNativeAvailable();
  const normalized = normalizeContentPartWithNative(part, reasoningCollector);
  reasoningCollector.splice(0, reasoningCollector.length, ...normalized.reasoningCollector);
  return normalized.normalized;
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
