import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";

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
  const desired = requested && requested > 0 ? requested : configuredDefault;
  if (desired && desired > 0) {
    params.max_tokens = desired;
    if ((params as Record<string, unknown>).max_output_tokens !== undefined) {
      (params as Record<string, unknown>).max_output_tokens = desired;
    }
  }
}
