import type { JsonObject } from './hub/types/json.js';
import { isCompactionRequestWithNative } from '../native/router-hotpath/native-shared-conversion-semantics.js';

export function isCompactionRequest(payload: JsonObject): boolean {
  return isCompactionRequestWithNative(payload);
}
