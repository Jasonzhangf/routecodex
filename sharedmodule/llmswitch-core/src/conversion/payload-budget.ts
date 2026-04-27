// Resolve payload budget (bytes) for a given model from host app config, with safety headroom.

import { UnifiedConfig } from '../config-unified/unified-config.js';
import { resolveBudgetForModelWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function resolveBudgetForModelSync(modelId: string): { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } {
  let viaFacade: { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } | null = null;
  try {
    const resolved = UnifiedConfig.getContextBudgetForModel(modelId);
    if (resolved && typeof resolved.allowedBytes === 'number') {
      viaFacade = resolved as { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string };
    }
  } catch {
    // ignore facade errors and fallback
  }
  if (viaFacade) {
    return viaFacade;
  }
  return resolveBudgetForModelWithNative(modelId, null);
}

export const resolveBudgetForModel = async (modelId: string) => resolveBudgetForModelSync(modelId);

// Proxy hard guard: real transport payload must remain semantically intact.
// Budget resolution may still be observed/used by diagnostics, but request payload
// itself must not be truncated or rewritten here.
export function enforceChatBudget(chat: any, modelId: string): any {
  void modelId;
  return chat;
}
