import type { StageRecorder } from "../format-adapters/index.js";
import type { StandardizedRequest } from "../types/standardized.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import {
  findMappableSemanticsKeysWithNative,
  liftResponsesResumeIntoSemanticsWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";
import { createHubSnapshotStageRecorder } from "./hub-pipeline-snapshot-recorder-blocks.js";

export function prepareChatProcessRuntimeMetadata(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
}): Record<string, unknown> {
  const metadata = prepareRuntimeMetadataForServertoolsWithNative({
    metadata: args.normalized.metadata,
    webSearchConfig: args.config.virtualRouter?.webSearch as unknown as
      | Record<string, unknown>
      | undefined,
    execCommandGuard: args.config.virtualRouter?.execCommandGuard as unknown as
      | Record<string, unknown>
      | undefined,
    clockConfig: args.config.virtualRouter?.clock as unknown as
      | Record<string, unknown>
      | undefined,
  });
  args.normalized.metadata = metadata;
  return metadata;
}

export function applyChatProcessSemanticGate(args: {
  request: StandardizedRequest;
  metadata: Record<string, unknown>;
  requestId: string;
}): StandardizedRequest {
  try {
    const lifted = liftResponsesResumeIntoSemanticsWithNative(
      args.request as unknown as Record<string, unknown>,
      args.metadata,
    );
    replaceMutableRecord(args.metadata, lifted.metadata);
    return lifted.request as unknown as StandardizedRequest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(
      `[HubPipeline][semantic_gate] Failed to lift protocol semantics into request.semantics before chat_process (requestId=${args.requestId || "unknown"}): ${reason}`,
    );
  }
}

export function assertNoMappableSemanticsInMetadata(metadata: Record<string, unknown>): void {
  const present = findMappableSemanticsKeysWithNative(metadata);
  if (present.length) {
    throw new Error(
      `[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (chat_process.request.entry): ${present.join(", ")}`,
    );
  }
}

export function createChatProcessSnapshotRecorder(args: {
  normalized: NormalizedRequest;
  adapterContext: AdapterContext;
  warningLabel: string;
}): StageRecorder | undefined {
  return createHubSnapshotStageRecorder(args);
}
