import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";


const QWEN_HARD_MAX_OUTPUT_TOKENS = 65_536;

function normalizeProviderIdentityToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

function isQwenProviderIdentity(value: string | undefined): boolean {
  if (!value) return false;
  return value === "qwen" || value.startsWith("qwen.") || value.includes(".qwen.") || value.includes("qwen/");
}

function resolveProviderHardMaxTokens(target: TargetMetadata, routerEngine: VirtualRouterEngine): number | undefined {
  const registry = (routerEngine as unknown as { providerRegistry?: { get?: (key: string) => any } }).providerRegistry;
  const profile = target.providerKey ? registry?.get?.(target.providerKey) : undefined;
  const identities = [
    normalizeProviderIdentityToken(target.providerType),
    normalizeProviderIdentityToken(target.providerKey),
    normalizeProviderIdentityToken(target.modelId),
    normalizeProviderIdentityToken(profile?.providerType),
    normalizeProviderIdentityToken(profile?.providerKey),
    normalizeProviderIdentityToken(profile?.modelId),
  ];
  return identities.some((value) => isQwenProviderIdentity(value)) ? QWEN_HARD_MAX_OUTPUT_TOKENS : undefined;
}

function resolveRequestedMaxTokens(request: StandardizedRequest | ProcessedRequest): number | undefined {
  const params = request.parameters || (request.parameters = {});
  const direct = typeof params.max_tokens === "number" && Number.isFinite(params.max_tokens) ? Math.floor(params.max_tokens) : undefined;
  const maxOutputRaw = typeof (params as Record<string, unknown>).max_output_tokens === "number" && Number.isFinite((params as Record<string, unknown>).max_output_tokens as number)
    ? Math.floor((params as Record<string, unknown>).max_output_tokens as number)
    : undefined;
  return direct ?? maxOutputRaw;
}

function resolveConfiguredDefaultMaxTokens(target: TargetMetadata, routerEngine: VirtualRouterEngine): number | undefined {
  const configuredTargetDefault = typeof target.maxOutputTokens === "number" && Number.isFinite(target.maxOutputTokens) ? Math.floor(target.maxOutputTokens) : undefined;
  if (configuredTargetDefault) return configuredTargetDefault;
  const registry = (routerEngine as unknown as { providerRegistry?: { get?: (key: string) => any } }).providerRegistry;
  const profile = registry?.get?.(target.providerKey);
  const profileDefault = typeof profile?.maxOutputTokens === "number" && Number.isFinite(profile.maxOutputTokens) ? Math.floor(profile.maxOutputTokens) : undefined;
  return profileDefault && profileDefault > 0 ? profileDefault : undefined;
}

function applyResolvedMaxTokens(request: StandardizedRequest | ProcessedRequest, desired: number | undefined): void {
  if (!desired || desired <= 0) return;
  const params = request.parameters || (request.parameters = {});
  params.max_tokens = desired;
  if ((params as Record<string, unknown>).max_output_tokens !== undefined) {
    (params as Record<string, unknown>).max_output_tokens = desired;
  }
}

export function applyMaxTokensPolicyForRequest(
  request: StandardizedRequest | ProcessedRequest,
  target: TargetMetadata | undefined,
  routerEngine: VirtualRouterEngine,
): void {
  if (!target) {
    return;
  }
  const requested = resolveRequestedMaxTokens(request);
  const configuredDefault = resolveConfiguredDefaultMaxTokens(
    target,
    routerEngine,
  );
  const hardCap = resolveProviderHardMaxTokens(target, routerEngine);
  const desiredBase = requested && requested > 0 ? requested : configuredDefault;
  const desired =
    desiredBase && desiredBase > 0 && hardCap && hardCap > 0
      ? Math.min(desiredBase, hardCap)
      : desiredBase;
  applyResolvedMaxTokens(request, desired);
}
