import type { ProviderRegistry } from '../provider-registry.js';
import type { RoutingFeatures } from '../types.js';
import { extractProviderId, getProviderModelId } from './key-parsing.js';

function isQwen35PlusProvider(providerKey: string, providerRegistry: ProviderRegistry): boolean {
  const providerId = (extractProviderId(providerKey) ?? '').trim().toLowerCase();
  if (providerId !== 'qwen') {
    return false;
  }
  const modelId = (getProviderModelId(providerKey, providerRegistry) ?? '').trim().toLowerCase();
  if (!modelId) {
    return false;
  }
  return modelId === 'qwen3.5-plus' || modelId === 'qwen3-5-plus' || modelId === 'qwen3_5-plus';
}

export function providerSupportsMultimodalRequest(
  providerKey: string,
  features: RoutingFeatures,
  providerRegistry: ProviderRegistry
): boolean {
  if (!features.hasImageAttachment) {
    return true;
  }
  if (!isQwen35PlusProvider(providerKey, providerRegistry)) {
    return true;
  }
  if (features.hasVideoAttachment !== true) {
    return true;
  }
  const hasRemoteVideo = features.hasRemoteVideoAttachment === true;
  const hasLocalVideo = features.hasLocalVideoAttachment === true;
  return hasRemoteVideo && !hasLocalVideo;
}
