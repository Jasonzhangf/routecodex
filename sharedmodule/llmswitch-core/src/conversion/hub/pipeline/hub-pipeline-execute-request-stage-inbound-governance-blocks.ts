import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import { measureHubStage } from "./hub-stage-timing.js";
import { assertNoMappableSemanticsInMetadata } from "./hub-pipeline-chat-process-entry-blocks.js";
import { appendInboundNodeResult } from "./hub-pipeline-execute-request-stage-inbound-blocks.js";
import { prepareInboundProcessMetadata } from "./hub-pipeline-execute-request-stage-inbound-setup.js";
import { executeToolGovernanceOrPassthrough } from "./hub-pipeline-governance-blocks.js";

export function prepareInboundGovernanceContext(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
  standardizedRequest: StandardizedRequest;
  inboundStart: number;
  activeProcessMode: "chat" | "passthrough";
}): {
  nodeResults: HubPipelineNodeResult[];
  metadata: Record<string, unknown>;
} {
  const inboundEnd = Date.now();
  const nodeResults: HubPipelineNodeResult[] = [];
  appendInboundNodeResult({
    nodeResults,
    inboundStart: args.inboundStart,
    inboundEnd,
    standardizedMessages: args.standardizedRequest.messages.length,
    standardizedTools: args.standardizedRequest.tools?.length ?? 0,
  });

  const metadata = prepareInboundProcessMetadata({
    normalized: args.normalized,
    config: args.config,
  });
  if (args.activeProcessMode !== "passthrough") {
    assertNoMappableSemanticsInMetadata(metadata);
  }

  return {
    nodeResults,
    metadata,
  };
}

export async function runInboundGovernancePipeline(args: {
  normalized: NormalizedRequest;
  standardizedRequest: StandardizedRequest;
  rawRequest: JsonObject;
  inboundRecorder?: StageRecorder;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
  metadata: Record<string, unknown>;
}): Promise<ProcessedRequest | undefined> {
  return measureHubStage(
    args.normalized.id,
    "req_process.stage1_tool_governance",
    () =>
      executeToolGovernanceOrPassthrough({
        requestId: args.normalized.id,
        entryEndpoint: args.normalized.entryEndpoint,
        standardizedRequest: args.standardizedRequest,
        rawPayload: args.rawRequest,
        metadata: args.metadata,
        stageRecorder: args.inboundRecorder,
        activeProcessMode: args.activeProcessMode,
        passthroughAudit: args.passthroughAudit,
        nodeResults: args.nodeResults,
      }),
  );
}
