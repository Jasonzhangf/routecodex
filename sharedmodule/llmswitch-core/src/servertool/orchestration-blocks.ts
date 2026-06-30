import type { JsonObject } from '../conversion/hub/types/json.js';

export function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  const newKeys = new Set(Object.keys(next));
  for (const [key, value] of Object.entries(next)) {
    (target as Record<string, unknown>)[key] = value;
  }
  for (const key of Object.keys(target)) {
    if (!newKeys.has(key)) {
      delete (target as Record<string, unknown>)[key];
    }
  }
}
