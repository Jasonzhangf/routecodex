import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../types/standardized.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import { resolveProviderHardMaxTokens } from "./hub-pipeline-max-tokens-identity-blocks.js";
import {
  applyResolvedMaxTokens,
  resolveConfiguredDefaultMaxTokens,
  resolveRequestedMaxTokens,
} from "./hub-pipeline-max-tokens-request-blocks.js";

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
