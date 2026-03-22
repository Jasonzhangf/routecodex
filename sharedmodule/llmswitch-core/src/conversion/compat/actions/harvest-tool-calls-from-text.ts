import type { JsonObject } from '../../hub/types/json.js';
import type { TextMarkupNormalizeOptions } from '../../shared/text-markup-normalizer.js';
import { harvestToolCallsFromTextWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export interface HarvestToolCallsFromTextConfig {
  normalizer?: TextMarkupNormalizeOptions;
}

export function harvestToolCallsFromText(payload: JsonObject): JsonObject {
  return harvestToolCallsFromTextWithConfig(payload);
}

export function harvestToolCallsFromTextWithConfig(
  payload: JsonObject,
  config?: HarvestToolCallsFromTextConfig
): JsonObject {
  const options =
    config?.normalizer && typeof config.normalizer === 'object'
      ? (config.normalizer as unknown as Record<string, unknown>)
      : undefined;
  return harvestToolCallsFromTextWithNative(
    payload as unknown as Record<string, unknown>,
    options
  ) as unknown as JsonObject;
}

