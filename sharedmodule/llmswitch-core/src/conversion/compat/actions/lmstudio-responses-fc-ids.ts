import type { JsonObject } from '../../hub/types/json.js';
import { enforceLmstudioResponsesFcToolCallIdsWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export function enforceLmstudioResponsesFcToolCallIds(payload: JsonObject): JsonObject {
  return enforceLmstudioResponsesFcToolCallIdsWithNative(
    payload as unknown as Record<string, unknown>
  ) as unknown as JsonObject;
}
