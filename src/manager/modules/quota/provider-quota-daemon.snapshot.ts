import {
  createInitialQuotaState,
  tickQuotaStateTime,
  type QuotaAuthType,
  type QuotaState,
  type StaticQuotaConfig
} from '../../quota/provider-quota-center.js';
import { loadProviderQuotaSnapshot, saveProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';
import { canonicalizeProviderKey, mergeQuotaStates } from './provider-key-normalization.js';

function normalizeLoadedQuotaState(providerKey: string, state: QuotaState): QuotaState {
  const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : state.providerKey;
  const rawAuth = typeof (state as unknown as { authType?: unknown }).authType === 'string'
    ? String((state as unknown as { authType?: string }).authType).trim().toLowerCase()
    : '';
  const authType: QuotaAuthType = rawAuth === 'apikey' ? 'apikey' : rawAuth === 'oauth' ? 'oauth' : 'unknown';
  // Migration: legacy snapshots may contain `reason: "fatal"` which used to represent an automatic long blacklist.
  // New policy forbids direct blacklists from errors; downgrade to cooldown semantics and keep the existing TTL.
  const reason = state.reason === 'fatal' ? 'cooldown' : state.reason;
  const cooldownUntil =
    state.reason === 'fatal'
      ? Math.max(
          typeof state.cooldownUntil === 'number' ? state.cooldownUntil : 0,
          typeof state.blacklistUntil === 'number' ? state.blacklistUntil : 0
        ) || null
      : state.cooldownUntil;
  const blacklistUntil = state.reason === 'fatal' ? null : state.blacklistUntil;
  return {
    ...state,
    providerKey: key,
    authType,
    reason,
    cooldownUntil,
    blacklistUntil
  };
}

export async function loadProviderQuotaStates(options: {
  staticConfigs: Map<string, StaticQuotaConfig>;
}): Promise<{ quotaStates: Map<string, QuotaState>; seeded: boolean; needsPersist: boolean }> {
  const quotaStates = new Map<string, QuotaState>();

  const snapshot = await loadProviderQuotaSnapshot();
  let migrated = false;
  if (snapshot && snapshot.providers && typeof snapshot.providers === 'object') {
    const grouped = new Map<string, QuotaState[]>();
    for (const [providerKey, state] of Object.entries(snapshot.providers)) {
      if (!state || typeof state !== 'object') {
        continue;
      }
      const normalized = normalizeLoadedQuotaState(providerKey, state as QuotaState);
      const canonicalKey = canonicalizeProviderKey(normalized.providerKey);
      if (canonicalKey !== normalized.providerKey) {
        migrated = true;
      }
      const bucket = grouped.get(canonicalKey);
      const adjusted = { ...normalized, providerKey: canonicalKey };
      if (bucket) {
        bucket.push(adjusted);
      } else {
        grouped.set(canonicalKey, [adjusted]);
      }
    }
    for (const [canonicalKey, states] of grouped.entries()) {
      if (states.length === 1) {
        quotaStates.set(canonicalKey, states[0]!);
        continue;
      }
      migrated = true;
      quotaStates.set(canonicalKey, mergeQuotaStates(canonicalKey, states));
    }
  }

  let needsPersist = false;
  if (quotaStates.size) {
    const nowMs = Date.now();
    let changed = false;
    for (const [providerKey, state] of quotaStates.entries()) {
      const next = tickQuotaStateTime(state, nowMs);
      if (next !== state) {
        quotaStates.set(providerKey, next);
        changed = true;
      }
    }
    if (changed || migrated) {
      needsPersist = true;
      // Best-effort: persist immediately so legacy duplicate keys don't survive restarts.
      try {
        await saveProviderQuotaSnapshot(Object.fromEntries(quotaStates.entries()), new Date(nowMs));
      } catch {
        // ignore persistence errors
      }
    }
  }

  let seeded = false;
  // Ensure we always have default entries for known providers (seeded via static configs),
  // so deleting the snapshot file doesn't permanently "hide" providers from admin views.
  if (options.staticConfigs.size) {
    const nowMs = Date.now();
    for (const [providerKey, cfg] of options.staticConfigs.entries()) {
      if (quotaStates.has(providerKey)) {
        continue;
      }
      quotaStates.set(providerKey, createInitialQuotaState(providerKey, cfg, nowMs));
      seeded = true;
    }
  }

  return { quotaStates, seeded, needsPersist };
}
