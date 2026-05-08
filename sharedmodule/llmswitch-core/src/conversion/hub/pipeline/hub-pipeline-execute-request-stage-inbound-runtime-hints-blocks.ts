import type { JsonObject } from "../types/json.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import {
  resolveApplyPatchToolModeFromEnvWithNative,
  resolveApplyPatchToolModeFromToolsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import type { NormalizedRequest } from "./hub-pipeline.js";

type ApplyPatchToolMode = "schema" | "freeform";

function resolveApplyPatchToolMode(
  rawRequest: JsonObject,
): ApplyPatchToolMode | undefined {
  const toolsRaw = Array.isArray((rawRequest as any)?.tools)
    ? ((rawRequest as any).tools as unknown[])
    : null;
  return (
    (resolveApplyPatchToolModeFromEnvWithNative() as
      | ApplyPatchToolMode
      | undefined) ??
    (resolveApplyPatchToolModeFromToolsWithNative(toolsRaw) as
      | ApplyPatchToolMode
      | undefined)
  );
}

export function applyApplyPatchToolModeRuntimeHint(
  normalized: NormalizedRequest,
  rawRequest: JsonObject,
): void {
  const applyPatchToolMode = resolveApplyPatchToolMode(rawRequest);
  if (!applyPatchToolMode) {
    return;
  }
  normalized.metadata = normalized.metadata || {};
  const rt = ensureRuntimeMetadata(
    normalized.metadata as Record<string, unknown>,
  );
  (rt as Record<string, unknown>).applyPatchToolMode = applyPatchToolMode;
}

export function applyCompactionRuntimeHint(
  normalized: NormalizedRequest,
  rawRequest: JsonObject,
): void {
  if (!isCompactionRequest(rawRequest)) {
    return;
  }
  normalized.metadata = normalized.metadata || {};
  const rt = ensureRuntimeMetadata(
    normalized.metadata as Record<string, unknown>,
  );
  (rt as Record<string, unknown>).compactionRequest = true;
}
