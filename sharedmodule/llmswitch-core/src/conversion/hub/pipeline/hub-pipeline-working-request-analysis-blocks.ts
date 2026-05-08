import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import { containsImageAttachment } from "../process/chat-process-media.js";
import { computeRequestTokens } from "../../../router/virtual-router/token-estimator.js";
import { estimateSessionBoundTokens } from "../process/chat-process-session-usage.js";
import {
  isHeavyInputFastpathEnabled,
  markHeavyInputFastpath,
  resolveHeavyInputTokenThreshold,
  roughEstimateInputTokensFromRequest,
} from "./hub-pipeline-heavy-input-fastpath.js";
import { logHubPipelineNonBlockingError } from "./hub-pipeline-runtime-blocks.js";

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
      estimatedTokens > 0 &&
      normalizedMetadata &&
      typeof normalizedMetadata === "object"
    ) {
      normalizedMetadata.estimatedInputTokens = estimatedTokens;
      if (fastpathEnabled && estimatedTokens >= threshold) {
        markHeavyInputFastpath({
          metadata: normalizedMetadata,
          estimatedInputTokens: estimatedTokens,
          reason: "full_estimate",
        });
      }
    }
  } catch (error) {
    logHubPipelineNonBlockingError(
      "estimateInputTokensForWorkingRequest",
      error,
    );
  }
}

export function deriveWorkingRequestFlags(
  workingRequest: StandardizedRequest | ProcessedRequest,
): {
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
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
    hasImageAttachment,
    serverToolRequired,
  };
}
