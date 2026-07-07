// StageRecorder inline: record(stage: string, payload: object): void
type StageRecorder = { record(stage: string, payload: object): void };
import { parseLenientJsonishWithNative } from '../../../../native/router-hotpath/native-shared-conversion-semantics.js';

function normalizeRecordPayload(payload: unknown): object {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as object;
  }
  try {
    const nativeParsed = parseLenientJsonishWithNative(payload);
    if (nativeParsed && typeof nativeParsed === 'object' && !Array.isArray(nativeParsed)) {
      return nativeParsed as object;
    }
  } catch (error) {
    // native normalization is best-effort, but failures should be visible for diagnostics
    console.warn('[hub-pipeline] native normalization failed (non-blocking):', error instanceof Error ? error.message : String(error));
  }
  return {};
}

export function recordStage(recorder: StageRecorder | undefined, stageId: string, payload: unknown): void {
  if (!recorder) {
    return;
  }
  try {
    recorder.record(stageId, normalizeRecordPayload(payload));
  } catch (err) {
    // Snapshot failures should not block the pipeline but must be visible.
    console.warn('[hub-pipeline] recordStage failed (non-blocking):', err instanceof Error ? err.message : String(err));
  }
}
