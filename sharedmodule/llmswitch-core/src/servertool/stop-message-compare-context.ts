import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  formatStopMessageCompareContextWithNative,
  normalizeStopMessageCompareContextWithNative,
  type StopMessageCompareContext
} from '../native/router-hotpath/native-servertool-core-semantics.js';
export type { StopMessageCompareContext } from '../native/router-hotpath/native-servertool-core-semantics.js';

const STOP_MESSAGE_COMPARE_KEY = 'stopMessageCompareContext';

export function attachStopMessageCompareContext(
  adapterContext: unknown,
  context: StopMessageCompareContext
): void {
  const runtime = ensureRuntimeMetadata(adapterContext as Record<string, unknown>);
  const normalized = normalizeStopMessageCompareContextWithNative(context);
  if (!normalized) {
    throw new Error('invalid stop-message compare context');
  }
  runtime[STOP_MESSAGE_COMPARE_KEY] = { ...normalized } as JsonObject;
}

export function readStopMessageCompareContext(adapterContext: unknown): StopMessageCompareContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const runtime = readRuntimeMetadata(adapterContext as Record<string, unknown>);
  const raw = runtime && typeof runtime === 'object' ? (runtime as Record<string, unknown>)[STOP_MESSAGE_COMPARE_KEY] : undefined;
  return normalizeStopMessageCompareContextWithNative(raw);
}

export function formatStopMessageCompareContext(context: StopMessageCompareContext | undefined): string {
  return formatStopMessageCompareContextWithNative(context);
}
