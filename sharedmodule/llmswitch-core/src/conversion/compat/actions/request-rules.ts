import type { JsonObject } from '../../hub/types/json.js';
import { applyRequestRulesWithNative } from '../../../native/router-hotpath/native-compat-action-semantics.js';

export interface RequestRulesConfig {
  tools?: {
    function?: {
      removeKeys?: string[];
    };
  };
  messages?: {
    assistantToolCalls?: {
      function?: {
        removeKeys?: string[];
      };
    };
  };
  topLevel?: {
    conditional?: Array<{
      when?: { tools?: 'empty' | 'present' };
      remove?: string[];
    }>;
  };
}

export function applyRequestRules(payload: JsonObject, config?: RequestRulesConfig): JsonObject {
  return applyRequestRulesWithNative(
    payload as unknown as Record<string, unknown>,
    (config ?? {}) as unknown as Record<string, unknown>
  ) as unknown as JsonObject;
}
