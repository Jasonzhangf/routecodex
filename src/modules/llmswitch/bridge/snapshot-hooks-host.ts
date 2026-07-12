/**
 * Snapshot hook native bridge surface.
 *
 * Snapshot hook planning and writes remain Rust/NAPI-owned; runtime
 * integrations use this narrow host for snapshot hook calls only.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

export {
  appendSnapshotStageTraceNative,
  classifyRuntimeErrorSignalNative,
  classifyEmptyResponseSignalNative,
  detectToolExecutionFailuresNative,
  resetSnapshotRecorderErrorsampleStateNative,
  resolveRequestTailSummaryNative,
  shouldInspectRuntimeErrorFastNative,
  shouldInspectToolFailuresNative,
  shouldLogClientToolErrorToConsoleNative,
  shouldLogRuntimeErrorSignalToConsoleNative,
  shouldRecordSnapshotsNative,
  shouldWriteClientToolErrorsampleNative,
  summarizeSnapshotStageTraceNative,
  summarizeClientToolObservationNative,
  writeSnapshotViaHooksNative,
} from './native-exports.js';

export function getSnapshotHooksNativeBindingSync(): Record<string, unknown> {
  return getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
}
