import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";

const QWEN_HARD_MAX_OUTPUT_TOKENS = 65_536;

export function normalizeProviderIdentityToken(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

export function isQwenProviderIdentity(
  value: string | undefined,
): boolean {
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

export function resolveProviderHardMaxTokens(
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
    normalizeProviderIdentityToken(target.providerType),
    normalizeProviderIdentityToken(target.providerKey),
    normalizeProviderIdentityToken(target.modelId),
    normalizeProviderIdentityToken(profile?.providerType),
    normalizeProviderIdentityToken(profile?.providerKey),
    normalizeProviderIdentityToken(profile?.modelId),
  ];

  return identities.some((value) => isQwenProviderIdentity(value))
    ? QWEN_HARD_MAX_OUTPUT_TOKENS
    : undefined;
}
