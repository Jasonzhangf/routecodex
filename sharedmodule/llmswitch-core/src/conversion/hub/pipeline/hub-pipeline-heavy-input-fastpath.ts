import { ensureRuntimeMetadata, readRuntimeMetadata } from "../../runtime-metadata.js";
import {
  isHeavyInputFastpathEnabled,
  resolveHeavyInputTokenThreshold,
} from "./hub-pipeline-heavy-input-fastpath-config.js";
import { roughEstimateInputTokensFromRequest } from "./hub-pipeline-heavy-input-fastpath-estimate.js";

export function shouldUseHeavyInputFastpath(metadata: unknown): boolean {
  if (!isHeavyInputFastpathEnabled()) {
    return false;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  if (rt?.hubFastpathHeavyInput === true) {
    return true;
  }
  const estimatedInputTokens =
    typeof record.estimatedInputTokens === "number" && Number.isFinite(record.estimatedInputTokens)
      ? record.estimatedInputTokens
      : typeof rt?.hubFastpathEstimatedInputTokens === "number" && Number.isFinite(rt.hubFastpathEstimatedInputTokens)
        ? Number(rt.hubFastpathEstimatedInputTokens)
        : undefined;
  if (estimatedInputTokens === undefined) {
    return false;
  }
  return estimatedInputTokens >= resolveHeavyInputTokenThreshold();
}

export function markHeavyInputFastpath(options?: unknown): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return;
  }
  const record = options as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  if (!metadata) {
    return;
  }

  const rt = ensureRuntimeMetadata(metadata);
  rt.hubFastpathHeavyInput = true;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : "heavy_input";
  rt.hubFastpathReason = reason;

  const estimatedInputTokens =
    typeof record.estimatedInputTokens === "number" && Number.isFinite(record.estimatedInputTokens)
      ? Math.max(0, Math.floor(record.estimatedInputTokens))
      : typeof metadata.estimatedInputTokens === "number" && Number.isFinite(metadata.estimatedInputTokens)
        ? Math.max(0, Math.floor(Number(metadata.estimatedInputTokens)))
        : undefined;
  if (estimatedInputTokens !== undefined) {
    metadata.estimatedInputTokens = estimatedInputTokens;
    rt.hubFastpathEstimatedInputTokens = estimatedInputTokens;
  }
}

export { roughEstimateInputTokensFromRequest, resolveHeavyInputTokenThreshold };
export { isHeavyInputFastpathEnabled };
