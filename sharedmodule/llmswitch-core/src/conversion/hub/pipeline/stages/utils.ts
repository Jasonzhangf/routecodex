import type { StageRecorder } from '../../format-adapters/index.js';
import { parseLenientJsonishWithNative } from '../../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

function normalizeRecordPayload(payload: unknown): object {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as object;
  }
  try {
    const nativeParsed = parseLenientJsonishWithNative(payload);
    if (nativeParsed && typeof nativeParsed === 'object' && !Array.isArray(nativeParsed)) {
      return nativeParsed as object;
    }
  } catch {
    // native normalization is best-effort
  }
  return {};
}

export function recordStage(recorder: StageRecorder | undefined, stageId: string, payload: unknown): void {
  if (!recorder) {
    return;
  }
  try {
    recorder.record(stageId, normalizeRecordPayload(payload));
  } catch {
    // Snapshot failures should not block the pipeline.
  }
}
