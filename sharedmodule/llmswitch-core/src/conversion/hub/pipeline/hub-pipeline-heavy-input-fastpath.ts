import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import { ensureRuntimeMetadata, readRuntimeMetadata } from "../../runtime-metadata.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

const DEFAULT_INPUT_TOKEN_THRESHOLD = 120_000;

type HeavyInputFastpathConfig = {
  enabled: boolean;
  inputTokenThreshold: number;
};

function readBooleanEnv(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) {
      continue;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY.has(normalized)) {
      return true;
    }
    if (FALSY.has(normalized)) {
      return false;
    }
  }
  return fallback;
}

function readPositiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) {
      continue;
    }
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function getConfig(): HeavyInputFastpathConfig {
  return {
    enabled: readBooleanEnv(
      [
        "ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT",
        "RCC_HUB_FASTPATH_HEAVY_INPUT",
      ],
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

export function isHeavyInputFastpathEnabled(): boolean {
  return getConfig().enabled;
}

function readEstimatedInputTokens(
  metadata?: Record<string, unknown>,
): number | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const candidate =
    typeof metadata.estimatedInputTokens === "number" &&
    Number.isFinite(metadata.estimatedInputTokens)
      ? Math.max(0, Math.floor(metadata.estimatedInputTokens))
      : undefined;
  if (candidate && candidate > 0) {
    return candidate;
  }
  const rt = readRuntimeMetadata(metadata);
  const rtCandidate =
    typeof (rt as Record<string, unknown> | undefined)
      ?.hubFastpathEstimatedInputTokens === "number" &&
    Number.isFinite(
      (rt as Record<string, unknown>).hubFastpathEstimatedInputTokens,
    )
      ? Math.max(
          0,
          Math.floor(
            (rt as Record<string, unknown>).hubFastpathEstimatedInputTokens as number,
          ),
        )
      : undefined;
  return rtCandidate && rtCandidate > 0 ? rtCandidate : undefined;
}

export function shouldUseHeavyInputFastpath(
  metadata?: Record<string, unknown>,
): {
  enabled: boolean;
  hit: boolean;
  threshold: number;
  estimatedInputTokens?: number;
} {
  const config = getConfig();
  const estimatedInputTokens = readEstimatedInputTokens(metadata);
  const rt = metadata ? readRuntimeMetadata(metadata) : undefined;
  const runtimeForced =
    rt &&
    typeof (rt as Record<string, unknown>).hubFastpathHeavyInput ===
      "boolean" &&
    (rt as Record<string, unknown>).hubFastpathHeavyInput === true;
  const hit =
    config.enabled &&
    (runtimeForced ||
      (typeof estimatedInputTokens === "number" &&
        estimatedInputTokens >= config.inputTokenThreshold));
  return {
    enabled: config.enabled,
    hit,
    threshold: config.inputTokenThreshold,
    ...(typeof estimatedInputTokens === "number"
      ? { estimatedInputTokens }
      : {}),
  };
}

export function markHeavyInputFastpath(options: {
  metadata?: Record<string, unknown>;
  estimatedInputTokens?: number;
  reason: "rough_estimate" | "full_estimate" | "metadata_threshold";
}): void {
  const { metadata, estimatedInputTokens, reason } = options;
  if (!metadata || typeof metadata !== "object") {
    return;
  }
  const config = getConfig();
  if (!config.enabled) {
    return;
  }
  const rt = ensureRuntimeMetadata(metadata);
  (rt as Record<string, unknown>).hubFastpathHeavyInput = true;
  (rt as Record<string, unknown>).hubFastpathReason = reason;
  (rt as Record<string, unknown>).hubFastpathInputTokenThreshold =
    config.inputTokenThreshold;
  if (
    typeof estimatedInputTokens === "number" &&
    Number.isFinite(estimatedInputTokens) &&
    estimatedInputTokens > 0
  ) {
    const rounded = Math.max(1, Math.floor(estimatedInputTokens));
    metadata.estimatedInputTokens = rounded;
    (rt as Record<string, unknown>).hubFastpathEstimatedInputTokens = rounded;
  }
}

export function buildCapturedChatRequestInput(args: {
  workingRequest: StandardizedRequest | ProcessedRequest;
  normalizedMetadata?: Record<string, unknown>;
}): {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  parameters?: unknown;
} {
  const { workingRequest, normalizedMetadata } = args;
  const fastpath = shouldUseHeavyInputFastpath(normalizedMetadata);
  if (fastpath.hit) {
    markHeavyInputFastpath({
      metadata: normalizedMetadata,
      estimatedInputTokens: fastpath.estimatedInputTokens,
      reason: "metadata_threshold",
    });
  }
  // Hard rule: captured request must preserve full semantic payload.
  return {
    model: workingRequest.model,
    messages: workingRequest.messages,
    tools: workingRequest.tools,
    parameters: workingRequest.parameters,
  };
}

function estimateContentChars(content: unknown, cap: number): number {
  if (cap <= 0 || content === undefined || content === null) {
    return 0;
  }
  if (typeof content === "string") {
    return Math.min(content.length, cap);
  }
  if (Array.isArray(content)) {
    let used = 0;
    for (const part of content) {
      if (used >= cap) {
        break;
      }
      if (typeof part === "string") {
        used += Math.min(part.length, cap - used);
        continue;
      }
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") {
        used += Math.min(record.text.length, cap - used);
      } else if (typeof record.input_text === "string") {
        used += Math.min(record.input_text.length, cap - used);
      } else if (typeof record.output_text === "string") {
        used += Math.min(record.output_text.length, cap - used);
      } else {
        used += Math.min(64, cap - used);
      }
    }
    return used;
  }
  return Math.min(64, cap);
}

export function roughEstimateInputTokensFromRequest(
  request: StandardizedRequest | ProcessedRequest,
): number {
  const config = getConfig();
  let chars = 0;
  const charCap = Math.max(config.inputTokenThreshold * 8, 16_384);

  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of messages) {
    if (chars >= charCap) {
      break;
    }
    if (!message || typeof message !== "object") {
      chars += 16;
      continue;
    }
    const record = message as unknown as Record<string, unknown>;
    if (typeof record.role === "string") {
      chars += Math.min(record.role.length, charCap - chars);
    }
    if (typeof record.name === "string") {
      chars += Math.min(record.name.length, Math.max(0, charCap - chars));
    }
    if (typeof record.tool_call_id === "string") {
      chars += Math.min(
        record.tool_call_id.length,
        Math.max(0, charCap - chars),
      );
    }
    chars += estimateContentChars(record.content, Math.max(0, charCap - chars));
    if (Array.isArray(record.tool_calls)) {
      chars += Math.min(record.tool_calls.length * 128, Math.max(0, charCap - chars));
    }
  }

  if (Array.isArray(request.tools)) {
    chars += request.tools.length * 256;
  }

  const estimated = Math.max(
    Math.ceil(chars / 3.5),
    messages.length * 8 + (Array.isArray(request.tools) ? request.tools.length * 32 : 0),
  );
  return Math.max(1, Math.floor(estimated));
}

export function resolveHeavyInputTokenThreshold(): number {
  return getConfig().inputTokenThreshold;
}
