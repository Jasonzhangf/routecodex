import { ensureRuntimeMetadata, readRuntimeMetadata } from "../../runtime-metadata.js";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const DEFAULT_INPUT_TOKEN_THRESHOLD = 120_000;

function readBooleanEnv(names: string[], defaultValue: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  return defaultValue;
}

function readPositiveIntEnv(names: string[], defaultValue: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

function getConfig() {
  return {
    enabled: readBooleanEnv(
      ["ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT", "RCC_HUB_FASTPATH_HEAVY_INPUT"],
      true,
    ),
    inputTokenThreshold: readPositiveIntEnv(
      [
        "ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD",
        "RCC_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD",
      ],
      DEFAULT_INPUT_TOKEN_THRESHOLD,
    ),
  };
}

function estimateTextTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTextTokens(item), 0);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return Math.ceil(record.text.length / 4);
    if (typeof record.content === "string") return Math.ceil(record.content.length / 4);
    let total = 0;
    for (const nested of Object.values(record)) total += estimateTextTokens(nested);
    return total;
  }
  return 0;
}

export function shouldUseHeavyInputFastpath(metadata: unknown): boolean {
  if (!isHeavyInputFastpathEnabled()) return false;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  if (rt?.hubFastpathHeavyInput === true) return true;
  const estimatedInputTokens =
    typeof record.estimatedInputTokens === "number" && Number.isFinite(record.estimatedInputTokens)
      ? record.estimatedInputTokens
      : typeof rt?.hubFastpathEstimatedInputTokens === "number" && Number.isFinite(rt.hubFastpathEstimatedInputTokens)
        ? Number(rt.hubFastpathEstimatedInputTokens)
        : undefined;
  return estimatedInputTokens !== undefined && estimatedInputTokens >= resolveHeavyInputTokenThreshold();
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

export function isHeavyInputFastpathEnabled(): boolean {
  return getConfig().enabled;
}

export function resolveHeavyInputTokenThreshold(): number {
  return getConfig().inputTokenThreshold;
}

export function roughEstimateInputTokensFromRequest(request: unknown): number {
  if (!request || typeof request !== "object" || Array.isArray(request)) return 0;
  const requestRecord = request as Record<string, unknown>;
  let total = 0;
  if (Array.isArray(requestRecord.messages)) total += estimateTextTokens(requestRecord.messages);
  if (Object.prototype.hasOwnProperty.call(requestRecord, "input")) total += estimateTextTokens(requestRecord.input);
  if (Object.prototype.hasOwnProperty.call(requestRecord, "instructions")) total += estimateTextTokens(requestRecord.instructions);
  if (total <= 0) total += estimateTextTokens(requestRecord);
  return Math.max(0, Math.floor(total));
}
