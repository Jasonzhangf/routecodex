import type { ProcessedRequest } from "../types/standardized.js";
import type { HubPipelineNodeResult } from "./hub-pipeline.js";
import {
  buildToolGovernanceNodeResultWithNative,
  mergeClockReservationIntoMetadataWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";


type ToolGovernanceNodeResult = {
  success: boolean;
  metadata: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export function propagateClockReservationToMetadata(
  processedRequest: ProcessedRequest | undefined,
  metadata: Record<string, unknown>,
): void {
  try {
    const next = mergeClockReservationIntoMetadataWithNative({
      processedRequest: processedRequest as unknown as Record<string, unknown>,
      metadata,
    });
    replaceMutableRecord(metadata, next);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    console.warn(`[hub-pipeline] propagateClockReservationToMetadata failed (non-blocking): ${reason}`);
  }
}

export function appendToolGovernanceNodeResult(
  nodeResults: HubPipelineNodeResult[],
  nodeResult: ToolGovernanceNodeResult | undefined,
): void {
  if (!nodeResult) {
    return;
  }
  nodeResults.push(
    buildToolGovernanceNodeResultWithNative(
      nodeResult as unknown as Record<string, unknown>,
    ) as unknown as HubPipelineNodeResult,
  );
}


