import type { StageRecorder } from "../format-adapters/index.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";

export function createHubSnapshotStageRecorder(args: {
  normalized: NormalizedRequest;
  adapterContext: AdapterContext;
  warningLabel: string;
}): StageRecorder | undefined {
  const { normalized, adapterContext, warningLabel } = args;
  if (normalized.externalStageRecorder) {
    return normalized.externalStageRecorder;
  }
  if (normalized.disableSnapshots === true) {
    return undefined;
  }
  if (!shouldRecordSnapshots()) {
    return undefined;
  }
  const effectiveEndpoint =
    normalized.entryEndpoint ||
    adapterContext.entryEndpoint ||
    "/v1/chat/completions";
  try {
    return createSnapshotRecorder(adapterContext, effectiveEndpoint);
  } catch (snapshotError) {
    console.warn(
      `[hub-pipeline] ${warningLabel} failed (non-blocking): ${
        snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
      }`,
    );
    return undefined;
  }
}
