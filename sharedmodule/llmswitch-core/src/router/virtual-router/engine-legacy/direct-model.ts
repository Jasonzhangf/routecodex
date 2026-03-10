import type { RoutingFeatures } from '../types.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { routeHasTargets } from './route-utils.js';

export function parseDirectProviderModel(
  engine: VirtualRouterEngine,
  model: string | undefined
): { providerId: string; modelId: string } | null {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) {
    return null;
  }
  const firstDot = raw.indexOf('.');
  if (firstDot <= 0 || firstDot === raw.length - 1) {
    return null;
  }
  const providerId = raw.slice(0, firstDot).trim();
  const modelId = raw.slice(firstDot + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }
  if (engine.providerRegistry.listProviderKeys(providerId).length === 0) {
    return null;
  }
  return { providerId, modelId };
}

export function shouldFallbackDirectModelForMedia(
  engine: VirtualRouterEngine,
  direct: { providerId: string; modelId: string },
  features: RoutingFeatures
): boolean {
  if (!features.hasImageAttachment) {
    return false;
  }
  const providerId = direct.providerId.trim().toLowerCase();
  const modelId = direct.modelId.trim().toLowerCase();
  if (providerId !== 'qwen') {
    return false;
  }
  const isQwen35Plus = modelId === 'qwen3.5-plus' || modelId === 'qwen3-5-plus' || modelId === 'qwen3_5-plus';
  if (!isQwen35Plus) {
    return false;
  }
  if (!(features.hasVideoAttachment === true && features.hasLocalVideoAttachment === true)) {
    return false;
  }
  return routeHasTargets(engine, engine.routing.vision);
}
