import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  formatStopMessageCompareContextWithNative,
  normalizeStopMessageCompareContextWithNative,
  type StopMessageCompareContext
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  readRuntimeControlFromAnyBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter
} from './metadata-center-carrier.js';
export type { StopMessageCompareContext } from '../native/router-hotpath/native-servertool-core-semantics.js';

const STOP_MESSAGE_COMPARE_KEY = 'stopMessageCompareContext';
const STOP_MESSAGE_COMPARE_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/stop-message-compare-context.ts',
  symbol: 'attachStopMessageCompareContext',
  stage: 'HubRespChatProcess03Governed'
} as const;

export function attachStopMessageCompareContext(
  adapterContext: unknown,
  context: StopMessageCompareContext
): void {
  const normalized = normalizeStopMessageCompareContextWithNative(context);
  if (!normalized) {
    throw new Error('invalid stop-message compare context');
  }
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    throw new Error('MetadataCenter runtime_control.stopMessageCompareContext writer requires object carrier');
  }
  writeRuntimeControlToBoundMetadataCenter({
    metadata: adapterContext as Record<string, unknown>,
    key: STOP_MESSAGE_COMPARE_KEY,
    value: { ...normalized } as JsonObject,
    writer: STOP_MESSAGE_COMPARE_WRITER,
    reason: 'stop-message compare control signal',
    required: true
  });
}

export function readStopMessageCompareContext(adapterContext: unknown): StopMessageCompareContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterContext as Record<string, unknown>);
  const raw = runtimeControl?.[STOP_MESSAGE_COMPARE_KEY];
  return normalizeStopMessageCompareContextWithNative(raw);
}

export function formatStopMessageCompareContext(context: StopMessageCompareContext | undefined): string {
  return formatStopMessageCompareContextWithNative(context);
}
