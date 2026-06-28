import type { JsonObject } from '../../types/json.js';

export interface CompatApplicationResult {
  payload: JsonObject;
  appliedProfile?: string;
}
