import type { JsonObject } from '../../hub/types/json.js';
import { enforceLmstudioResponsesFcToolCallIdsWithNative } from '../../../native/router-hotpath/native-compat-action-semantics.js';

export function enforceLmstudioResponsesFcToolCallIds(payload: JsonObject): JsonObject {
  return enforceLmstudioResponsesFcToolCallIdsWithNative(
    payload as unknown as Record<string, unknown>
  ) as unknown as JsonObject;
}
