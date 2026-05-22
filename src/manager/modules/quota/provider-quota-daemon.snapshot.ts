import {
  createInitialQuotaState,
  tickQuotaStateTime,
  type QuotaAuthType,
  type QuotaState,
  type StaticQuotaConfig
} from '../../quota/provider-quota-center.js';
import {
  loadProviderQuotaSnapshot,
  saveProviderQuotaSnapshot,
  sanitizeQuotaStateForSnapshot
} from '../../quota/provider-quota-store.js';
import { canonicalizeProviderKey, mergeQuotaStates } from './provider-key-normalization.js';

function resolveWindsurfAliasPrefix(providerKey: string): string | null {
  const raw = typeof providerKey === 'string' ? providerKey.trim().toLowerCase() : '';
  if (!raw.startsWith('windsurf.')) {
    return null;
  }
  const parts = raw.split('.');
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]}.${parts[1]}`;
}

function isWindsurfWeeklyBlacklistState(state: QuotaState): boolean {
  const lastErrorCode =
    typeof (state as unknown as { lastErrorCode?: unknown }).lastErrorCode === 'string'
      ? String((state as unknown as { lastErrorCode?: string }).lastErrorCode).trim()
      : '';
  return state.reason === 'blacklist' && lastErrorCode === 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED';
}

function expandWindsurfWeeklyBlacklists(args: {
  grouped: Map<string, QuotaState[]>;
  staticConfigs: Map<string, StaticQuotaConfig>;
}): boolean {
  const aliasWindows = new Map<string, QuotaState>();
  for (const [providerKey, states] of args.grouped.entries()) {
    const aliasPrefix = resolveWindsurfAliasPrefix(providerKey);
    if (!aliasPrefix) {
      continue;
    }
    for (const state of states) {
      if (!isWindsurfWeeklyBlacklistState(state)) {
        continue;
      }
      const previous = aliasWindows.get(aliasPrefix);
      if (!previous) {
        aliasWindows.set(aliasPrefix, state);
        continue;
      }
      const prevUntil = typeof previous.blacklistUntil === 'number' ? previous.blacklistUntil : 0;
      const nextUntil = typeof state.blacklistUntil === 'number' ? state.blacklistUntil : 0;
      if (nextUntil >= prevUntil) {
        aliasWindows.set(aliasPrefix, state);
      }
    }
  }
  if (aliasWindows.size === 0) {
    return false;
  }

  let migrated = false;
  const ensureWeeklyBlacklist = (providerKey: string, template: QuotaState) => {
    const canonicalKey = canonicalizeProviderKey(providerKey);
    const existing = args.grouped.get(canonicalKey) ?? [];
    const alreadyCovered = existing.some((state) => {
      if (!isWindsurfWeeklyBlacklistState(state)) {
        return false;
      }
      return state.blacklistUntil === template.blacklistUntil;
    });
    if (alreadyCovered) {
      return;
    }
    const base =
      existing[0]
      ?? createInitialQuotaState(canonicalKey, args.staticConfigs.get(canonicalKey), template.lastErrorAtMs ?? Date.now());
    const injected: QuotaState = sanitizeQuotaStateForSnapshot({
      ...base,
      providerKey: canonicalKey,
      authType: 'apikey',
      inPool: false,
      reason: 'blacklist',
      cooldownUntil: null,
      cooldownKeepsPool: undefined,
      blacklistUntil: template.blacklistUntil,
      lastErrorSeries: 'E429',
      lastErrorCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
      lastErrorAtMs: template.lastErrorAtMs ?? base.lastErrorAtMs ?? Date.now(),
      consecutiveErrorCount:
        typeof base.consecutiveErrorCount === 'number' && base.consecutiveErrorCount > 0
          ? base.consecutiveErrorCount
          : 1
    });
    args.grouped.set(canonicalKey, [...existing, injected]);
    migrated = true;
  };

  for (const [aliasPrefix, template] of aliasWindows.entries()) {
    ensureWeeklyBlacklist(aliasPrefix, template);
    const normalizedPrefix = `${aliasPrefix}.`;
    for (const providerKey of args.staticConfigs.keys()) {
      const normalizedKey = canonicalizeProviderKey(providerKey);
      if (normalizedKey === aliasPrefix || normalizedKey.startsWith(normalizedPrefix)) {
        ensureWeeklyBlacklist(normalizedKey, template);
      }
    }
    for (const providerKey of Array.from(args.grouped.keys())) {
      if (providerKey === aliasPrefix || providerKey.startsWith(normalizedPrefix)) {
        ensureWeeklyBlacklist(providerKey, template);
      }
    }
  }

  return migrated;
}

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
  const normalized: QuotaState = {
    ...state,
    providerKey: key,
    authType,
    reason,
    cooldownUntil,
    blacklistUntil
  };
  return sanitizeQuotaStateForSnapshot(normalized);
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
    if (expandWindsurfWeeklyBlacklists({ grouped, staticConfigs: options.staticConfigs })) {
      migrated = true;
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
