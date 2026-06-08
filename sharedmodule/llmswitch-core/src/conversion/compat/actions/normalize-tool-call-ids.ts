import type { JsonObject } from '../../hub/types/json.js';
import { normalizeToolCallIdsWithNative } from '../../../native/router-hotpath/native-compat-action-semantics.js';

export function normalizeToolCallIdsInPlace(root: JsonObject): void {
  const normalized = normalizeToolCallIdsWithNative(root as unknown as Record<string, unknown>);
  for (const key of Object.keys(root)) {
    if (!(key in normalized)) {
      delete (root as Record<string, unknown>)[key];
    }
  }
  Object.assign(root as Record<string, unknown>, normalized);
}
