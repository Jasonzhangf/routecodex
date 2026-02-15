import {
  fetchAntigravityQuotaSnapshot,
  loadAntigravityAccessToken,
  type AntigravityQuotaSnapshot
} from '../../../providers/core/runtime/antigravity-quota-client.js';
import { scanProviderTokenFiles } from '../../../providers/auth/token-scanner/index.js';
import { resolveAntigravityApiBase } from '../../../providers/auth/antigravity-userinfo-helper.js';
import type { QuotaRecordLike } from './antigravity-quota-persistence.js';

export interface AntigravityTokenRegistration {
  alias: string;
  tokenFile: string;
  apiBase: string;
}

export async function syncAntigravityTokensFromDisk(options: {
  currentTokens: Map<string, AntigravityTokenRegistration>;
  currentSnapshot: Record<string, QuotaRecordLike>;
  parseSnapshotKey: (key: string) => { alias: string; modelId: string } | null;
  readProtectedModelsFromTokenFile: (tokenFile: string) => Promise<Set<string>>;
}): Promise<{
  tokens: Map<string, AntigravityTokenRegistration>;
  protectedModels: Map<string, Set<string>>;
  snapshot: Record<string, QuotaRecordLike>;
  snapshotChanged: boolean;
}> {
  let matches: Array<{ filePath: string; sequence: number; alias: string }> = [];
  try {
    matches = await scanProviderTokenFiles('antigravity');
  } catch {
    matches = [];
  }
  if (!matches.length) {
    return {
      tokens: new Map(),
      protectedModels: new Map(),
      snapshot: Object.keys(options.currentSnapshot).length ? {} : options.currentSnapshot,
      snapshotChanged: Object.keys(options.currentSnapshot).length > 0
    };
  }

  const base = resolveAntigravityApiBase();
  const next = new Map<string, AntigravityTokenRegistration>();
  const nextProtectedModels = new Map<string, Set<string>>();
  const legacyAliases: string[] = [];
  for (const match of matches) {
    const alias = (match.alias && match.alias !== 'default' ? match.alias : String(match.sequence)).trim();
    if (!alias) {
      continue;
    }
    const legacyAlias =
      match.alias && match.alias !== 'default' ? `${match.sequence}-${match.alias}`.trim() : null;
    if (legacyAlias) {
      legacyAliases.push(legacyAlias);
    }
    next.set(alias, {
      alias,
      tokenFile: match.filePath,
      apiBase: base
    });
    const protectedModels = await options.readProtectedModelsFromTokenFile(match.filePath);
    if (protectedModels.size > 0) {
      nextProtectedModels.set(alias, protectedModels);
    }
  }

  for (const [alias, reg] of options.currentTokens.entries()) {
    if (!next.has(alias)) {
      next.set(alias, reg);
    }
  }

  let snapshot = options.currentSnapshot;
  let snapshotChanged = false;
  if (legacyAliases.length && snapshot && typeof snapshot === 'object') {
    const legacyPrefixes = legacyAliases.map((a) => `antigravity://${a}/`);
    const rawEntries = Object.entries(snapshot);
    const cleaned: Record<string, QuotaRecordLike> = {};
    for (const [key, value] of rawEntries) {
      const drop = legacyPrefixes.some((prefix) => key.startsWith(prefix));
      if (drop) {
        snapshotChanged = true;
        continue;
      }
      cleaned[key] = value;
    }
    if (snapshotChanged) {
      snapshot = cleaned;
    }
  }

  if (snapshot && typeof snapshot === 'object') {
    const allowedAliases = new Set<string>(Array.from(next.keys()));
    const rawEntries = Object.entries(snapshot);
    let staleChanged = false;
    const cleaned: Record<string, QuotaRecordLike> = {};
    for (const [key, value] of rawEntries) {
      const parsed = options.parseSnapshotKey(key);
      if (parsed && !allowedAliases.has(parsed.alias)) {
        staleChanged = true;
        continue;
      }
      cleaned[key] = value;
    }
    if (staleChanged) {
      snapshotChanged = true;
      snapshot = cleaned;
    }
  }

  return {
    tokens: next,
    protectedModels: nextProtectedModels,
    snapshot,
    snapshotChanged
  };
}

export async function refreshAllAntigravityQuotas(options: {
  tokens: Map<string, AntigravityTokenRegistration>;
  syncTokensFromDisk: () => Promise<void>;
  updateAntigravityQuota: (alias: string, quota: AntigravityQuotaSnapshot) => void;
}): Promise<{ attempted: number; successCount: number; failureCount: number }> {
  await options.syncTokensFromDisk();
  if (options.tokens.size === 0) {
    return { attempted: 0, successCount: 0, failureCount: 0 };
  }
  let attempted = 0;
  let successCount = 0;
  let failureCount = 0;
  for (const { alias, tokenFile, apiBase } of options.tokens.values()) {
    try {
      const accessToken = await loadAntigravityAccessToken(tokenFile);
      if (!accessToken) {
        continue;
      }
      attempted += 1;
      const snapshot = await fetchAntigravityQuotaSnapshot(apiBase, accessToken, { alias });
      if (!snapshot) {
        failureCount += 1;
        continue;
      }
      options.updateAntigravityQuota(alias, snapshot);
      successCount += 1;
    } catch {
      failureCount += 1;
    }
  }
  return { attempted, successCount, failureCount };
}

export function applyAntigravityQuotaToCore(options: {
  coreQuotaManager: {
    updateProviderPoolState?: (options: {
      providerKey: string;
      inPool: boolean;
      reason?: string | null;
      cooldownUntil?: number | null;
      blacklistUntil?: number | null;
    }) => void;
  } | null;
  providerKey: string;
  record: QuotaRecordLike;
  nowMs: number;
  protectedReason: string;
  isProviderProtected: (providerKey: string) => boolean;
}): void {
  const mgr = options.coreQuotaManager;
  if (!mgr || typeof mgr.updateProviderPoolState !== 'function') {
    return;
  }
  if (options.isProviderProtected(options.providerKey)) {
    mgr.updateProviderPoolState({
      providerKey: options.providerKey,
      inPool: false,
      reason: options.protectedReason,
      cooldownUntil: null,
      blacklistUntil: null
    });
    return;
  }
  const remaining = options.record.remainingFraction;
  const resetAt =
    typeof options.record.resetAt === 'number' && Number.isFinite(options.record.resetAt)
      ? options.record.resetAt
      : null;
  const withinResetWindow = typeof resetAt === 'number' && resetAt > options.nowMs;
  const hasQuota =
    typeof remaining === 'number' &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    (resetAt === null || withinResetWindow);
  if (hasQuota) {
    mgr.updateProviderPoolState({
      providerKey: options.providerKey,
      inPool: true,
      reason: 'ok',
      cooldownUntil: null,
      blacklistUntil: null
    });
    return;
  }
  mgr.updateProviderPoolState({
    providerKey: options.providerKey,
    inPool: false,
    reason: 'quotaDepleted',
    cooldownUntil: null,
    blacklistUntil: null
  });
}
