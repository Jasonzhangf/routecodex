import type { JsonObject } from "../types/json.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { REQUEST_STAGE_HOOKS } from "./hub-pipeline-stage-hooks.js";

export function requireJsonObjectPayload(normalized: NormalizedRequest): JsonObject {
  const payload = normalized.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Responses pipeline requires JSON object payload");
  }
  return payload as JsonObject;
}

export function requireRequestStageHooks<TContext = Record<string, unknown>>(
  providerProtocol: NormalizedRequest["providerProtocol"],
): RequestStageHooks<TContext> {
  const hooks = REQUEST_STAGE_HOOKS[providerProtocol];
  if (!hooks) {
    throw new Error(
      `Unsupported provider protocol for hub pipeline: ${providerProtocol}`,
    );
  }
  return hooks as RequestStageHooks<TContext>;
}
