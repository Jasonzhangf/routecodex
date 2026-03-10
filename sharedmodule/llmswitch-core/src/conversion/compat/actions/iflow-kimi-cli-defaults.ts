import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildIflowRequestCompatInput } from './iflow-native-compat.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeModel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isKimiK25Model(value: unknown): boolean {
  const model = normalizeModel(value);
  return model === 'kimi-k2.5' || model.startsWith('kimi-k2.5-');
}

/**
 * iFlow/Kimi request defaults aligned with iflow-cli:
 * - thinking enabled path: temperature=1
 * - thinking disabled path: temperature=0.6
 * - shared defaults: top_p=0.95, n=1, penalties=0, max_new_tokens=max_tokens
 *
 * RouteCodex keeps thinking enabled by default for kimi-k2.5 unless explicitly disabled.
 */
export function applyIflowKimiCliDefaults(payload: JsonObject): JsonObject {
  try {
    if (!isRecord(payload) || !isKimiK25Model((payload as UnknownRecord).model)) {
      return payload;
    }
    return runReqOutboundStage3CompatWithNative(buildIflowRequestCompatInput(payload)).payload;
  } catch {
    return payload;
  }
}
