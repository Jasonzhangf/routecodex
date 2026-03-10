import type { ProviderRegistry } from '../provider-registry.js';
import { extractProviderId, getProviderModelId } from './key-parsing.js';

type PriorityMeta = { groupId: string; groupBase: number; base: number };

function resolvePriorityMeta(orderedTargets: string[], providerRegistry: ProviderRegistry): Map<string, PriorityMeta> {
  // Priority mode semantics (strict group priority + alias-level balancing):
  // - Targets are interpreted as ordered (providerId, modelId) groups.
  // - Group base priorities: 100, 90, 80, ... (step=10) by appearance order.
  // - Within a group (different auth aliases), base scores: 100, 99, 98, ... (step=1).
  //
  // Group selection is strict: always use the best group until it is unavailable.
  // Alias selection is balanced within the chosen group (RR / health-weighted / context-weighted).
  const meta = new Map<string, PriorityMeta>();
  if (!Array.isArray(orderedTargets) || orderedTargets.length === 0) {
    return meta;
  }
  let groupIndex = -1;
  let aliasOffset = 0;
  let lastGroupKey = '';
  for (const key of orderedTargets) {
    const providerId = extractProviderId(key) ?? '';
    const modelId = getProviderModelId(key, providerRegistry) ?? '';
    const groupKey = `${providerId}::${modelId}`;
    if (groupKey !== lastGroupKey) {
      groupIndex += 1;
      aliasOffset = 0;
      lastGroupKey = groupKey;
    }
    const groupBase = 100 - groupIndex * 10;
    const base = groupBase - aliasOffset;
    meta.set(key, { groupId: `${providerId}.${modelId}`, groupBase, base });
    aliasOffset += 1;
  }
  return meta;
}

export function pickPriorityGroup(opts: {
  candidates: string[];
  orderedTargets: string[];
  providerRegistry: ProviderRegistry;
  availabilityCheck: (key: string) => boolean;
  penalties?: Record<string, number>;
}): { groupId: string; groupCandidates: string[] } | null {
  const { candidates, orderedTargets, providerRegistry, availabilityCheck, penalties } = opts;
  const meta = resolvePriorityMeta(orderedTargets, providerRegistry);
  let bestGroupId: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const key of candidates) {
    if (!availabilityCheck(key)) continue;
    const m = meta.get(key);
    if (!m) continue;
    const penalty = penalties ? Math.max(0, Math.floor(penalties[key] ?? 0)) : 0;
    const score = m.base - penalty;
    if (score > bestScore) {
      bestScore = score;
      bestGroupId = m.groupId;
    }
  }
  if (!bestGroupId) return null;
  const groupCandidates = candidates.filter((key) => meta.get(key)?.groupId === bestGroupId);
  return groupCandidates.length ? { groupId: bestGroupId, groupCandidates } : null;
}
