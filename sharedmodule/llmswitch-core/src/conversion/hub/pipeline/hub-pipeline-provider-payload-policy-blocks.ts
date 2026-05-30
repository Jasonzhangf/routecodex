import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
export function resolveCompatibilityProfile(
  outboundAdapterContext: Record<string, unknown>,
): string | undefined {
  return typeof outboundAdapterContext.compatibilityProfile === "string"
    ? outboundAdapterContext.compatibilityProfile
    : undefined;
}
