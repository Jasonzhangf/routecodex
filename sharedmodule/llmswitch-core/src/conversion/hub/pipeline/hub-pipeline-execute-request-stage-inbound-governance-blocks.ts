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
  assertNoMappableSemanticsInMetadata(metadata);

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
        nodeResults: args.nodeResults,
      }),
  );
}
