import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";

const QWEN_HARD_MAX_OUTPUT_TOKENS = 65_536;

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

function isQwenTarget(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    value === "qwen" ||
    value.startsWith("qwen.") ||
    value.includes(".qwen.") ||
    value.includes("qwen/")
  );
}

function resolveHardMaxTokens(
  target: TargetMetadata,
  routerEngine: VirtualRouterEngine,
): number | undefined {
  const registry = (routerEngine as unknown as {
    providerRegistry?: { get?: (key: string) => any };
  }).providerRegistry;
  const profile = target.providerKey
    ? registry?.get?.(target.providerKey)
    : undefined;

  const identities = [
    normalizeToken(target.providerType),
    normalizeToken(target.providerKey),
    normalizeToken(target.modelId),
    normalizeToken(profile?.providerType),
    normalizeToken(profile?.providerKey),
    normalizeToken(profile?.modelId),
  ];

  if (identities.some((value) => isQwenTarget(value))) {
    return QWEN_HARD_MAX_OUTPUT_TOKENS;
  }
  return undefined;
}

export function applyMaxTokensPolicyForRequest(
  request: StandardizedRequest | ProcessedRequest,
  target: TargetMetadata | undefined,
  routerEngine: VirtualRouterEngine,
): void {
  if (!target) {
    return;
  }
  const params = request.parameters || (request.parameters = {});
  const direct =
    typeof params.max_tokens === "number" && Number.isFinite(params.max_tokens)
      ? Math.floor(params.max_tokens)
      : undefined;
  const maxOutputRaw =
    typeof (params as Record<string, unknown>).max_output_tokens === "number" &&
    Number.isFinite((params as Record<string, unknown>).max_output_tokens as number)
      ? Math.floor((params as Record<string, unknown>).max_output_tokens as number)
      : undefined;
  const requested = direct ?? maxOutputRaw;
  let configuredDefault =
    typeof target.maxOutputTokens === "number" &&
    Number.isFinite(target.maxOutputTokens)
      ? Math.floor(target.maxOutputTokens)
      : undefined;
  if (!configuredDefault) {
    const registry = (routerEngine as unknown as {
      providerRegistry?: { get?: (key: string) => any };
    }).providerRegistry;
    const profile = registry?.get?.(target.providerKey);
    const candidate =
      typeof profile?.maxOutputTokens === "number" &&
      Number.isFinite(profile.maxOutputTokens)
        ? Math.floor(profile.maxOutputTokens)
        : undefined;
    if (candidate && candidate > 0) {
      configuredDefault = candidate;
    }
  }
  const hardCap = resolveHardMaxTokens(target, routerEngine);
  const desiredBase = requested && requested > 0 ? requested : configuredDefault;
  const desired =
    desiredBase && desiredBase > 0 && hardCap && hardCap > 0
      ? Math.min(desiredBase, hardCap)
      : desiredBase;
  if (desired && desired > 0) {
    params.max_tokens = desired;
    if ((params as Record<string, unknown>).max_output_tokens !== undefined) {
      (params as Record<string, unknown>).max_output_tokens = desired;
    }
  }
}
