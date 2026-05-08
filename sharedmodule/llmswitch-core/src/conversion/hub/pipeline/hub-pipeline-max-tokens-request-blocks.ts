import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";

export function resolveRequestedMaxTokens(
  request: StandardizedRequest | ProcessedRequest,
): number | undefined {
  const params = request.parameters || (request.parameters = {});
  const direct =
    typeof params.max_tokens === "number" && Number.isFinite(params.max_tokens)
      ? Math.floor(params.max_tokens)
      : undefined;
  const maxOutputRaw =
    typeof (params as Record<string, unknown>).max_output_tokens === "number" &&
    Number.isFinite(
      (params as Record<string, unknown>).max_output_tokens as number,
    )
      ? Math.floor(
          (params as Record<string, unknown>).max_output_tokens as number,
        )
      : undefined;
  return direct ?? maxOutputRaw;
}

export function resolveConfiguredDefaultMaxTokens(
  target: TargetMetadata,
  routerEngine: VirtualRouterEngine,
): number | undefined {
  const configuredTargetDefault =
    typeof target.maxOutputTokens === "number" &&
    Number.isFinite(target.maxOutputTokens)
      ? Math.floor(target.maxOutputTokens)
      : undefined;
  if (configuredTargetDefault) {
    return configuredTargetDefault;
  }
  const registry = (routerEngine as unknown as {
    providerRegistry?: { get?: (key: string) => any };
  }).providerRegistry;
  const profile = registry?.get?.(target.providerKey);
  const profileDefault =
    typeof profile?.maxOutputTokens === "number" &&
    Number.isFinite(profile.maxOutputTokens)
      ? Math.floor(profile.maxOutputTokens)
      : undefined;
  return profileDefault && profileDefault > 0 ? profileDefault : undefined;
}

export function applyResolvedMaxTokens(
  request: StandardizedRequest | ProcessedRequest,
  desired: number | undefined,
): void {
  if (!desired || desired <= 0) {
    return;
  }
  const params = request.parameters || (request.parameters = {});
  params.max_tokens = desired;
  if ((params as Record<string, unknown>).max_output_tokens !== undefined) {
    (params as Record<string, unknown>).max_output_tokens = desired;
  }
}
