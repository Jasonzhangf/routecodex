import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import type { StandardizedRequest } from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import {
  buildPassthroughAuditWithNative,
  resolveActiveProcessModeWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  stripHistoricalImageAttachments,
  stripHistoricalVisualToolOutputs,
} from "../process/chat-process-media.js";
import { peekHubStageTopSummary } from "./hub-stage-timing.js";

export function sanitizeStandardizedRequestMessages(
  standardizedRequest: StandardizedRequest,
): StandardizedRequest {
  return {
    ...standardizedRequest,
    messages: stripHistoricalVisualToolOutputs(
      stripHistoricalImageAttachments(standardizedRequest.messages),
    ),
  };
}

export function resolveActiveProcessModeAndAudit(args: {
  normalized: Pick<NormalizedRequest, "processMode" | "providerProtocol">;
  requestMessages: StandardizedRequest["messages"];
  rawPayload: Record<string, unknown>;
}): {
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
} {
  const { normalized, requestMessages, rawPayload } = args;
  const activeProcessMode = resolveActiveProcessModeWithNative(
    normalized.processMode,
    requestMessages,
  );
  if (activeProcessMode !== normalized.processMode) {
    normalized.processMode = activeProcessMode;
  }
  const passthroughAudit =
    activeProcessMode === "passthrough"
      ? buildPassthroughAuditWithNative(rawPayload, normalized.providerProtocol)
      : undefined;
  return { activeProcessMode, passthroughAudit };
}

export function attachHubStageTopSummary(args: {
  requestId: string;
  metadata: Record<string, unknown>;
}): void {
  const hubStageTop = peekHubStageTopSummary(args.requestId);
  if (!hubStageTop.length) return;
  const rt = ensureRuntimeMetadata(args.metadata);
  (rt as Record<string, unknown>).hubStageTop = hubStageTop as unknown;
}
