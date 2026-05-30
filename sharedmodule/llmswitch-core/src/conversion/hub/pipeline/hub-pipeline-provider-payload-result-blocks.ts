import type { JsonObject } from "../types/json.js";
import type { NormalizedRequest } from "./hub-pipeline.js";

import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";

export function buildProviderPayloadStageResult(args: {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
  outboundWorkingRequest: StandardizedRequest | ProcessedRequest;
}): {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
  outboundWorkingRequest: StandardizedRequest | ProcessedRequest;
} {
  return {
    providerPayload: args.providerPayload,
    shadowBaselineProviderPayload: args.shadowBaselineProviderPayload,
    outboundWorkingRequest: args.outboundWorkingRequest,
  };
}
