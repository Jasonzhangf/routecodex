import { jsonClone } from "../types/json.js";
import type { JsonObject } from "../types/json.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import { syncPassthroughAudit } from "./hub-pipeline-provider-payload-policy-blocks.js";

export function buildPassthroughProviderPayload(args: {
  rawRequest: JsonObject;
  outboundStream: boolean;
  passthroughAudit?: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
}): Record<string, unknown> {
  const providerPayload = jsonClone(args.rawRequest as any) as Record<
    string,
    unknown
  >;
  if (typeof args.outboundStream === "boolean") {
    providerPayload.stream = args.outboundStream;
  }
  syncPassthroughAudit(
    args.passthroughAudit,
    providerPayload,
    args.outboundProtocol,
  );
  return providerPayload;
}
