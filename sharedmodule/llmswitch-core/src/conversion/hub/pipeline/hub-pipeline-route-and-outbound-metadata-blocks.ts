import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import type { HubPolicyMode } from "../policy/policy-engine.js";
import {
  applyHasImageAttachmentFlagWithNative,
  buildCapturedChatRequestSnapshotWithNative,
  buildHubPipelineResultMetadataWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { buildCapturedChatRequestInput } from "./hub-pipeline-heavy-input-captured-request.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";

type ShadowCompareBaselineMode =
  NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;

function isCapturedChatRequestShapeValid(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.messages) ||
    (Object.prototype.hasOwnProperty.call(record, "input") &&
      record.input !== undefined)
  );
}

export function buildValidatedCapturedChatRequest(args: {
  normalized: NormalizedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  activeProcessMode: "chat" | "passthrough";
}): Record<string, unknown> {
  const capturedChatRequest = buildCapturedChatRequestSnapshotWithNative(
    buildCapturedChatRequestInput({
      workingRequest: args.workingRequest,
      normalizedMetadata:
        args.normalized.metadata as Record<string, unknown> | undefined,
    }),
  );
  if (!isCapturedChatRequestShapeValid(capturedChatRequest)) {
    throw Object.assign(
      new Error(
        "[HubPipeline] capturedChatRequest must be chat-like (messages or input) for response-side servertool.",
      ),
      {
        code: "ERR_CAPTURED_CHAT_REQUEST_INVALID",
        requestId: args.normalized.id,
        processMode: args.activeProcessMode,
        entryEndpoint: args.normalized.entryEndpoint,
      },
    );
  }
  return capturedChatRequest;
}

export function finalizeRouteAndOutboundMetadata(args: {
  normalized: NormalizedRequest;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  target: HubPipelineResult["target"];
  outboundStream: boolean;
  capturedChatRequest: Record<string, unknown>;
  passthroughAudit?: Record<string, unknown>;
  shadowCompareBaselineMode?: ShadowCompareBaselineMode;
  effectivePolicyMode?: HubPolicyMode;
  shadowBaselineProviderPayload?: Record<string, unknown>;
  hasImageAttachment: boolean;
}): Record<string, unknown> {
  const metadata = buildHubPipelineResultMetadataWithNative({
    normalized: {
      metadata: args.normalized.metadata,
      entryEndpoint: args.normalized.entryEndpoint,
      stream: args.normalized.stream,
      processMode: args.normalized.processMode,
      routeHint: args.normalized.routeHint,
    },
    outboundProtocol: args.outboundProtocol,
    target: args.target,
    outboundStream: args.outboundStream,
    capturedChatRequest: args.capturedChatRequest,
    passthroughAudit: args.passthroughAudit,
    shadowCompareBaselineMode: args.shadowCompareBaselineMode,
    effectivePolicy: args.effectivePolicyMode
      ? { mode: args.effectivePolicyMode }
      : undefined,
    shadowBaselineProviderPayload: args.shadowBaselineProviderPayload,
  });
  const metadataWithImageFlag = applyHasImageAttachmentFlagWithNative({
    metadata,
    hasImageAttachment: args.hasImageAttachment,
  });
  replaceMutableRecord(metadata, metadataWithImageFlag);
  return metadata;
}
