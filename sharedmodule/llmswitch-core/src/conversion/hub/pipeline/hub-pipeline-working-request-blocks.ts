import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import { syncResponsesContextFromCanonicalMessagesWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  deriveWorkingRequestFlags,
  estimateInputTokensForWorkingRequest,
} from "./hub-pipeline-working-request-analysis-blocks.js";

export function finalizeWorkingRequestForOutbound(args: {
  request: StandardizedRequest | ProcessedRequest | Record<string, unknown>;
  normalized: NormalizedRequest;
}): {
  workingRequest: StandardizedRequest | ProcessedRequest;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const workingRequest = syncResponsesContextFromCanonicalMessagesWithNative(
    args.request as Record<string, unknown>,
  ) as unknown as StandardizedRequest | ProcessedRequest;
  estimateInputTokensForWorkingRequest({
    workingRequest,
    normalizedMetadata:
      (args.normalized.metadata as Record<string, unknown> | undefined) ??
      ((args.normalized.metadata = {}) as Record<string, unknown>),
  });
  return {
    workingRequest,
    ...deriveWorkingRequestFlags(workingRequest),
  };
}
