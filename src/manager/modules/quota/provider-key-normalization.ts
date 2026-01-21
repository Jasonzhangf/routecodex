import { createInitialQuotaState, type QuotaAuthType, type QuotaState } from '../../quota/provider-quota-center.js';

export function canonicalizeProviderKey(providerKey: string): string {
  const key = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!key) {
    return '';
  }
  // Historical bug: some builds encoded OAuth token sequence into runtime alias,
  // producing provider keys like "antigravity.1-foo.<modelId>" alongside "antigravity.foo.<modelId>".
  // Sequence is NOT part of the semantic alias; canonicalize to the non-prefixed form.
  const match = key.match(/^antigravity\.(\d+)-([^.]+)\.(.+)$/i);
  if (!match) {
    return key;
  }
  const alias = match[2];
  const rest = match[3];
  return `antigravity.${alias}.${rest}`;
}

export function mergeQuotaStates(providerKey: string, states: QuotaState[]): QuotaState {
  const usable = Array.isArray(states) ? states.filter(Boolean) : [];
  if (usable.length === 0) {
    return createInitialQuotaState(providerKey, undefined, Date.now());
  }

  let base = usable[0]!;
  for (const s of usable) {
    if (typeof s.windowStartMs === 'number' && s.windowStartMs > base.windowStartMs) {
      base = s;
    }
  }

  const reasonRank: Record<string, number> = {
    ok: 0,
    cooldown: 1,
    quotaDepleted: 2,
    fatal: 3,
    blacklist: 4
  };

  let worstReason = base.reason;
  let cooldownUntil: number | null = base.cooldownUntil ?? null;
  let blacklistUntil: number | null = base.blacklistUntil ?? null;
  let authType: QuotaAuthType = base.authType ?? 'unknown';
  let priorityTier = typeof base.priorityTier === 'number' ? base.priorityTier : 100;
  let totalTokensUsed = typeof base.totalTokensUsed === 'number' ? base.totalTokensUsed : 0;
  let lastErrorSeries = base.lastErrorSeries ?? null;
  let consecutiveErrorCount = typeof base.consecutiveErrorCount === 'number' ? base.consecutiveErrorCount : 0;

  for (const s of usable) {
    const r0 = typeof worstReason === 'string' ? worstReason : 'ok';
    const r1 = typeof s.reason === 'string' ? s.reason : 'ok';
    if ((reasonRank[r1] ?? 0) > (reasonRank[r0] ?? 0)) {
      worstReason = r1 as any;
    }

    const c = typeof s.cooldownUntil === 'number' && Number.isFinite(s.cooldownUntil) ? s.cooldownUntil : null;
    const b = typeof s.blacklistUntil === 'number' && Number.isFinite(s.blacklistUntil) ? s.blacklistUntil : null;
    cooldownUntil = c !== null ? (cooldownUntil !== null ? Math.max(cooldownUntil, c) : c) : cooldownUntil;
    blacklistUntil = b !== null ? (blacklistUntil !== null ? Math.max(blacklistUntil, b) : b) : blacklistUntil;

    if (s.authType === 'oauth' || authType === 'oauth') {
      authType = 'oauth';
    } else if (s.authType === 'apikey' || authType === 'apikey') {
      authType = 'apikey';
    }

    if (typeof s.priorityTier === 'number' && Number.isFinite(s.priorityTier)) {
      priorityTier = Math.min(priorityTier, s.priorityTier);
    }

    if (typeof s.totalTokensUsed === 'number' && Number.isFinite(s.totalTokensUsed)) {
      totalTokensUsed = Math.max(totalTokensUsed, s.totalTokensUsed);
    }

    if (typeof s.consecutiveErrorCount === 'number' && Number.isFinite(s.consecutiveErrorCount)) {
      if (s.consecutiveErrorCount > consecutiveErrorCount) {
        consecutiveErrorCount = s.consecutiveErrorCount;
        lastErrorSeries = s.lastErrorSeries ?? lastErrorSeries;
      }
    }
  }

  const merged: QuotaState = {
    ...base,
    providerKey,
    authType,
    priorityTier,
    totalTokensUsed,
    cooldownUntil,
    blacklistUntil,
    lastErrorSeries,
    consecutiveErrorCount,
    inPool: worstReason === 'ok',
    reason: (worstReason || 'ok') as any
  };

  // If any cooldown/blacklist window is active, force it out of pool even if reason drifted.
  const nowMs = Date.now();
  const activeBlacklist = merged.blacklistUntil !== null && nowMs < merged.blacklistUntil;
  const activeCooldown = merged.cooldownUntil !== null && nowMs < merged.cooldownUntil;
  if (activeBlacklist) {
    merged.inPool = false;
    merged.reason = 'blacklist';
  } else if (activeCooldown && merged.reason === 'ok') {
    merged.inPool = false;
    merged.reason = 'cooldown';
  }

  return merged;
}
