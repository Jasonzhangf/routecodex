import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import {
  findMappableSemanticsKeysWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type { StageRecorder } from "../format-adapters/index.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";

export function assertNoMappableSemanticsInMetadata(metadata: Record<string, unknown>): void {
  const present = findMappableSemanticsKeysWithNative(metadata);
  if (present.length) {
    throw new Error(
      `[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (chat_process.request.entry): ${present.join(", ")}`,
    );
  }
}

export function prepareChatProcessRuntimeMetadata(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
}): Record<string, unknown> {
  const metaBase = prepareRuntimeMetadataForServertoolsWithNative({
    metadata: args.normalized.metadata,
    webSearchConfig: args.config.virtualRouter?.webSearch as any,
    execCommandGuard: args.config.virtualRouter?.execCommandGuard as any,
    clockConfig: args.config.virtualRouter?.clock as any, applyPatchConfig: (args.config.virtualRouter as any)?.applyPatch as any,
  });
  args.normalized.metadata = metaBase;
  return metaBase;
}

export function createChatProcessSnapshotRecorder(args: {
  normalized: NormalizedRequest;
  adapterContext: AdapterContext;
  warningLabel: string;
}): StageRecorder | undefined {
  const { normalized, adapterContext, warningLabel } = args;
  if (normalized.externalStageRecorder) return normalized.externalStageRecorder;
  if (normalized.disableSnapshots === true) return undefined;
  if (!shouldRecordSnapshots()) return undefined;
  const effectiveEndpoint =
    normalized.entryEndpoint || adapterContext.entryEndpoint || "/v1/chat/completions";
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
