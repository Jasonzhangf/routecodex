import type { JsonObject } from './hub/types/json.js';
import { isCompactionRequestWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function isCompactionRequest(payload: JsonObject): boolean {
  return isCompactionRequestWithNative(payload);
}
