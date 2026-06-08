import type { JsonObject } from '../../hub/types/json.js';
import { validateResponsePayloadWithNative } from '../../../native/router-hotpath/native-compat-action-semantics.js';

export interface ResponseValidateConfig {
  strict?: boolean;
}

export function validateResponsePayload(payload: JsonObject, _config?: ResponseValidateConfig): void {
  validateResponsePayloadWithNative(payload as unknown as Record<string, unknown>);
}
