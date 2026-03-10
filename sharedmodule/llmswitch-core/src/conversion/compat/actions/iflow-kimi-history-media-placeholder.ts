import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildIflowRequestCompatInput } from './iflow-native-compat.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * iFlow/Kimi multimodal compat:
 * - Preserve latest user turn media payload.
 * - Replace historical inline-base64 image/video parts with text placeholders.
 */
export function applyIflowKimiHistoryMediaPlaceholder(payload: JsonObject): JsonObject {
  try {
    if (!isRecord(payload)) {
      return payload;
    }
    const model = typeof payload.model === 'string' ? payload.model.trim().toLowerCase() : '';
    if (model !== 'kimi-k2.5') {
      return payload;
    }
    return runReqOutboundStage3CompatWithNative(buildIflowRequestCompatInput(payload)).payload;
  } catch {
    return payload;
  }
}
