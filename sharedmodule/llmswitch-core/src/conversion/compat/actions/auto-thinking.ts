import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGlmRequestCompatInput } from './glm-native-compat.js';

export interface AutoThinkingConfig {
  modelPrefixes?: string[];
  excludePrefixes?: string[];
}

export function applyAutoThinking(payload: JsonObject, config?: AutoThinkingConfig): JsonObject {
  if (!config) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const modelId = typeof record.model === 'string' ? record.model.toLowerCase().trim() : '';
  if (!modelId) {
    return payload;
  }
  const prefixes = config.modelPrefixes ?? [];
  const exclude = config.excludePrefixes ?? [];
  const matches =
    prefixes.length === 0
      ? true
      : prefixes.some(prefix => modelId.startsWith(prefix.toLowerCase()));
  const excluded = exclude.some(prefix => modelId.startsWith(prefix.toLowerCase()));
  if (!matches || excluded) {
    return payload;
  }
  const thinkingNode = (record as { thinking?: Record<string, unknown> }).thinking;
  if (thinkingNode && typeof thinkingNode === 'object') {
    return payload;
  }
  return runReqOutboundStage3CompatWithNative(buildGlmRequestCompatInput(payload)).payload;
}
