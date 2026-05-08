import type { JsonObject } from "../types/json.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import { buildPassthroughProviderPayload } from "./hub-pipeline-provider-payload-passthrough-blocks.js";

export function resolvePassthroughProviderPayload(args: {
  rawRequest: JsonObject;
  outboundStream: boolean;
  passthroughAudit?: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
}): {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
} {
  return {
    providerPayload: buildPassthroughProviderPayload({
      rawRequest: args.rawRequest,
      outboundStream: args.outboundStream,
      passthroughAudit: args.passthroughAudit,
      outboundProtocol: args.outboundProtocol,
    }),
    shadowBaselineProviderPayload: undefined,
  };
}

export function buildProviderPayloadStageResult(args: {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
}): {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
} {
  return {
    providerPayload: args.providerPayload,
    shadowBaselineProviderPayload: args.shadowBaselineProviderPayload,
  };
}
