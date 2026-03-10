import type { JsonObject } from '../../hub/types/json.js';
import { validateResponsePayloadWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export interface ResponseValidateConfig {
  strict?: boolean;
}

export function validateResponsePayload(payload: JsonObject, _config?: ResponseValidateConfig): void {
  validateResponsePayloadWithNative(payload as unknown as Record<string, unknown>);
}
