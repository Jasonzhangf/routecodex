import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import {
  containsImageAttachment,
  repairIncompleteToolCalls,
  stripHistoricalImageAttachments,
  stripHistoricalVisualToolOutputs,
} from "../process/chat-process-media.js";
import { buildPassthroughAuditWithNative, readResponsesResumeFromRequestSemanticsWithNative, resolveActiveProcessModeWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import { computeRequestTokens } from "../../../router/virtual-router/token-estimator.js";
import { estimateSessionBoundTokens } from "../process/chat-process-session-usage.js";
import {
  isHeavyInputFastpathEnabled,
  markHeavyInputFastpath,
  resolveHeavyInputTokenThreshold,
  roughEstimateInputTokensFromRequest,
} from "./hub-pipeline-heavy-input-fastpath.js";

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

export function propagateApplyPatchToolModeToRequestMetadata(
  normalizedMetadata: Record<string, unknown> | undefined,
  standardizedRequest: StandardizedRequest,
): void {
  try {
    const rt = readRuntimeMetadata(
      (normalizedMetadata ?? {}) as Record<string, unknown>,
    );
    const mode = String((rt as any)?.applyPatchToolMode || "")
      .trim()
      .toLowerCase();
    if (mode === "freeform" || mode === "schema") {
      (
        standardizedRequest.metadata as Record<string, unknown>
      ).applyPatchToolMode = mode;
    }
  } catch {
    // best-effort: do not block request handling due to metadata propagation failures
  }
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

export function estimateInputTokensForWorkingRequest(args: {
  workingRequest: StandardizedRequest | ProcessedRequest;
  normalizedMetadata: Record<string, unknown> | undefined;
}): void {
  const { workingRequest, normalizedMetadata } = args;
  try {
    const fastpathEnabled = isHeavyInputFastpathEnabled();
    const threshold = resolveHeavyInputTokenThreshold();
    if (fastpathEnabled && threshold > 0) {
      const roughEstimate = roughEstimateInputTokensFromRequest(workingRequest);
      if (roughEstimate >= threshold) {
        if (normalizedMetadata && typeof normalizedMetadata === "object") {
          normalizedMetadata.estimatedInputTokens = roughEstimate;
          markHeavyInputFastpath({
            metadata: normalizedMetadata,
            estimatedInputTokens: roughEstimate,
            reason: "rough_estimate",
          });
        }
        return;
      }
    }

    const estimatedTokens =
      estimateSessionBoundTokens(
        workingRequest,
        normalizedMetadata as Record<string, unknown> | undefined,
      ) ?? computeRequestTokens(workingRequest, "");
    if (
      typeof estimatedTokens === "number" &&
      Number.isFinite(estimatedTokens) &&
      estimatedTokens > 0
    ) {
      if (normalizedMetadata && typeof normalizedMetadata === "object") {
        normalizedMetadata.estimatedInputTokens = estimatedTokens;
        if (fastpathEnabled && estimatedTokens >= threshold) {
          markHeavyInputFastpath({
            metadata: normalizedMetadata,
            estimatedInputTokens: estimatedTokens,
            reason: "full_estimate",
          });
        }
      }
    }
  } catch {
    // 估算失败不应影响主流程
  }
}

export function deriveWorkingRequestFlags(
  workingRequest: StandardizedRequest | ProcessedRequest,
): {
  responsesResume?: Record<string, unknown>;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const responsesResume =
    readResponsesResumeFromRequestSemanticsWithNative(workingRequest);
  const stdMetadata = (
    workingRequest as StandardizedRequest | ProcessedRequest | undefined
  )?.metadata as Record<string, unknown> | undefined;
  const hasImageAttachment = containsImageAttachment(
    (workingRequest.messages ?? []) as StandardizedRequest["messages"],
  );
  const serverToolRequired =
    stdMetadata?.webSearchEnabled === true ||
    stdMetadata?.serverToolRequired === true;
  return {
    responsesResume,
    hasImageAttachment,
    serverToolRequired,
  };
}
