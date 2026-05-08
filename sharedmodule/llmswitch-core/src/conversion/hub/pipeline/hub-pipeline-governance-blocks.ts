import type { StageRecorder } from "../format-adapters/index.js";
import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { HubPipelineNodeResult } from "./hub-pipeline.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { runReqProcessStage1ToolGovernance } from "./stages/req_process/req_process_stage1_tool_governance/index.js";
import { peekHubStageTopSummary } from "./hub-stage-timing.js";
import {
  annotatePassthroughAuditSkipped,
  appendPassthroughGovernanceSkippedNode,
  appendToolGovernanceNodeResult,
  propagateClockReservationToMetadata,
} from "./hub-pipeline-chat-process-governance-utils.js";

export async function executeToolGovernanceOrPassthrough(args: {
  requestId: string;
  entryEndpoint: string;
  standardizedRequest: StandardizedRequest;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stageRecorder?: StageRecorder;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
}): Promise<ProcessedRequest | undefined> {
  if (args.activeProcessMode === "passthrough") {
    appendPassthroughGovernanceSkippedNode(args.nodeResults);
    annotatePassthroughAuditSkipped(args.passthroughAudit);
    return undefined;
  }

  const processResult = await runReqProcessStage1ToolGovernance({
    request: args.standardizedRequest,
    rawPayload: args.rawPayload,
    metadata: args.metadata,
    entryEndpoint: args.entryEndpoint,
    requestId: args.requestId,
    stageRecorder: args.stageRecorder,
  });
  const processedRequest = processResult.processedRequest;
  propagateClockReservationToMetadata(processedRequest, args.metadata);
  appendToolGovernanceNodeResult(
    args.nodeResults,
    processResult.nodeResult as any,
  );
  return processedRequest;
}

export function attachHubStageTopSummary(args: {
  requestId: string;
  metadata: Record<string, unknown>;
}): void {
  const hubStageTop = peekHubStageTopSummary(args.requestId);
  if (!hubStageTop.length) {
    return;
  }
  const rt = ensureRuntimeMetadata(args.metadata);
  (rt as Record<string, unknown>).hubStageTop = hubStageTop as unknown;
}
