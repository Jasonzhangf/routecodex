import type { JsonObject } from '../../hub/types/json.js';
import { normalizeResponsePayloadWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export interface ResponseNormalizeConfig {
  finishReasonMap?: Record<string, string>;
}

export function normalizeResponsePayload(payload: JsonObject, config?: ResponseNormalizeConfig): JsonObject {
  return normalizeResponsePayloadWithNative(
    payload as unknown as Record<string, unknown>,
    (config ?? {}) as unknown as Record<string, unknown>
  ) as unknown as JsonObject;
}
