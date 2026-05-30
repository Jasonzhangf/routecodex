import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import type { StandardizedRequest } from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
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
  activeProcessMode: "chat";
} {
  if (args.normalized.processMode === "passthrough") {
    throw new Error(`[HubPipeline] processMode='passthrough' is no longer supported. Input metadata.processMode='passthrough' must be removed.`);
  }
  return { activeProcessMode: "chat" };
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
