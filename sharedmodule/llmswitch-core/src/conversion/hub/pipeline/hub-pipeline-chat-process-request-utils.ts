import type { AdapterContext } from "../types/chat-envelope.js";
import type {
  StandardizedRequest,
} from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import {
  repairIncompleteToolCalls,
  stripHistoricalImageAttachments,
  stripHistoricalVisualToolOutputs,
} from "../process/chat-process-media.js";
import { buildPassthroughAuditWithNative, resolveActiveProcessModeWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  prepareReasoningStopRequestTooling,
} from "./hub-pipeline-reasoning-stop-request-tooling.js";
export { prepareReasoningStopRequestTooling } from "./hub-pipeline-reasoning-stop-request-tooling.js";
export { propagateApplyPatchToolModeToRequestMetadata } from "./hub-pipeline-request-metadata-blocks.js";
export {
  deriveWorkingRequestFlags,
  estimateInputTokensForWorkingRequest,
} from "./hub-pipeline-working-request-analysis-blocks.js";

export function sanitizeStandardizedRequestMessages(
  standardizedRequest: StandardizedRequest,
): StandardizedRequest {
  return {
    ...standardizedRequest,
    messages: repairIncompleteToolCalls(
      stripHistoricalVisualToolOutputs(
        stripHistoricalImageAttachments(standardizedRequest.messages),
      ),
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
