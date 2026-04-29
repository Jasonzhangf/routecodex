// Resolve payload budget (bytes) for a given model from native routing semantics.

import { resolveBudgetForModelWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function resolveBudgetForModelSync(modelId: string): { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } {
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
