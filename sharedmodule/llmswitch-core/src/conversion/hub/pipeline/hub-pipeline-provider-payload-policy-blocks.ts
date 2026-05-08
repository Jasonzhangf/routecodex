import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import {
  attachPassthroughProviderInputAuditWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";

export function resolveCompatibilityProfile(
  outboundAdapterContext: Record<string, unknown>,
): string | undefined {
  return typeof outboundAdapterContext.compatibilityProfile === "string"
    ? outboundAdapterContext.compatibilityProfile
    : undefined;
}

export function syncPassthroughAudit(
  passthroughAudit: Record<string, unknown> | undefined,
  providerPayload: Record<string, unknown>,
  outboundProtocol: NormalizedRequest["providerProtocol"],
): void {
  if (!passthroughAudit) {
    return;
  }
  const next = attachPassthroughProviderInputAuditWithNative(
    passthroughAudit,
    providerPayload,
    outboundProtocol,
  );
  replaceMutableRecord(passthroughAudit, next);
}
