// Resolve payload budget (bytes) for a given model from host app config, with safety headroom.

import { UnifiedConfig } from '../config-unified/unified-config.js';
import {
  enforceChatBudgetWithNative,
  resolveBudgetForModelWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

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

// Apply payload budget enforcement to an OpenAI Chat-shaped request object in-place.
// Strategy (deterministic, minimal):
// 1) Truncate the first system message to RCC_SYSTEM_TEXT_LIMIT (default 8192 chars).
// 2) Remove assistant messages that have no tool_calls and empty/whitespace content.
// 3) Iteratively clamp tool role message content down to fit allowedBytes.
// 4) If仍超限，轻度收紧 assistant 文本（不移除，仅截断）。
export function enforceChatBudget(chat: any, modelId: string): any {
  try {
    if (!chat || typeof chat !== 'object') return chat;
    const messages: any[] = Array.isArray((chat as any).messages) ? ((chat as any).messages as any[]) : [];
    if (!messages.length) return chat;

    const budget = resolveBudgetForModelSync(modelId || 'unknown');
    const allowed = Math.max(1024, Number(budget.allowedBytes || 200000));
    const sysLimit = (() => {
      const raw = (process as any)?.env?.RCC_SYSTEM_TEXT_LIMIT; const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 8192;
    })();
    return enforceChatBudgetWithNative(chat, allowed, sysLimit) as any;
  } catch {
    // ignore budget errors
  }
  return chat;
}
