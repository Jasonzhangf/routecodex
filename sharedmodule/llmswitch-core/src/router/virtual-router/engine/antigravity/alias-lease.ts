import type { RouterMetadataInput, VirtualRouterConfig } from '../../types.js';
import type { ProviderRegistry } from '../../provider-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRccPath,
  resolveRccPathForRead
} from '../../../../runtime/user-data-paths.js';

export type AntigravityAliasLeaseStore = Map<string, { sessionKey: string; lastSeenAt: number }>;
export type AntigravitySessionAliasStore = Map<string, string>;

export type AntigravityLeasePersistenceState = {
  loadedOnce: boolean;
  loadedMtimeMs: number | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logAliasLeaseNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[alias-lease] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    void 0;
  }
}

export function resolveAntigravityAliasReuseCooldownMs(config: VirtualRouterConfig): number {
  const cfg = (config.loadBalancing as any)?.aliasSelection?.sessionLeaseCooldownMs;
  if (typeof cfg === 'number' && Number.isFinite(cfg)) {
    return Math.max(0, Math.floor(cfg));
  }
  return 5 * 60_000;
}

function resolveAntigravityLeaseScope(providerRegistry: ProviderRegistry, providerKey: string): 'gemini' | null {
  try {
    const profile = providerRegistry.get(providerKey) as unknown as { modelId?: unknown };
    const modelId = typeof profile?.modelId === 'string' ? profile.modelId.trim().toLowerCase() : '';
    if (modelId.startsWith('gemini-')) {
      return 'gemini';
    }
    return null;
  } catch (resolveScopeError) {
    logAliasLeaseNonBlockingError('resolveAntigravityLeaseScope', resolveScopeError, { providerKey });
    return null;
  }
}

function buildScopedSessionKey(sessionKey: string): string {
  return `${sessionKey}::gemini`;
}

function buildAntigravityLeaseRuntimeKey(runtimeKey: string): string {
  return `${runtimeKey}::gemini`;
}

function extractRuntimeKey(providerKey: string): string | null {
  const value = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!value) return null;
  const firstDot = value.indexOf('.');
  if (firstDot <= 0 || firstDot === value.length - 1) return null;
  const secondDot = value.indexOf('.', firstDot + 1);
  if (secondDot <= firstDot + 1) return null;
  const providerId = value.slice(0, firstDot);
  const alias = value.slice(firstDot + 1, secondDot);
  if (!providerId || !alias) return null;
  return `${providerId}.${alias}`;
}

function resolveAntigravityAliasLeasePersistWritePath(): string | null {
  try {
    const enabledRaw = process.env.ROUTECODEX_ANTIGRAVITY_ALIAS_LEASE_PERSIST;
    const enabled =
      typeof enabledRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(enabledRaw.trim().toLowerCase());
    if (!enabled) {
      return null;
    }
    return resolveRccPath('state', 'antigravity-alias-leases.json');
  } catch (resolveWritePathError) {
    logAliasLeaseNonBlockingError('resolveAntigravityAliasLeasePersistWritePath', resolveWritePathError);
    return null;
  }
}

function resolveAntigravityAliasLeasePersistReadPath(): string | null {
  try {
    const writePath = resolveAntigravityAliasLeasePersistWritePath();
    if (!writePath) {
      return null;
    }
    const resolved = resolveRccPathForRead('state', 'antigravity-alias-leases.json');
    return fs.existsSync(resolved) ? resolved : writePath;
  } catch (resolveReadPathError) {
    logAliasLeaseNonBlockingError('resolveAntigravityAliasLeasePersistReadPath', resolveReadPathError);
    return null;
  }
}

export function hydrateAntigravityAliasLeaseStoreIfNeeded(options: {
  force?: boolean;
  leaseStore: AntigravityAliasLeaseStore;
  persistence: AntigravityLeasePersistenceState;
  aliasReuseCooldownMs: number;
}): void {
  const filePath = resolveAntigravityAliasLeasePersistReadPath();
  if (!filePath) {
    return;
  }
  const force = options.force === true;
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch (statError) {
    logAliasLeaseNonBlockingError('hydrateAntigravityAliasLeaseStoreIfNeeded.statSync', statError, { filePath });
    options.persistence.loadedOnce = true;
    options.persistence.loadedMtimeMs = null;
    return;
  }
  const mtimeMs =
    typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime.getTime();
  if (!force && options.persistence.loadedOnce && options.persistence.loadedMtimeMs === mtimeMs) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (readError) {
    logAliasLeaseNonBlockingError('hydrateAntigravityAliasLeaseStoreIfNeeded.readParse', readError, { filePath });
    options.persistence.loadedOnce = true;
    options.persistence.loadedMtimeMs = mtimeMs;
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    options.persistence.loadedOnce = true;
    options.persistence.loadedMtimeMs = mtimeMs;
    return;
  }
  const leasesRaw = (parsed as any).leases;
  if (!leasesRaw || typeof leasesRaw !== 'object' || Array.isArray(leasesRaw)) {
    options.persistence.loadedOnce = true;
    options.persistence.loadedMtimeMs = mtimeMs;
    return;
  }
  const now = Date.now();
  const cooldownMs = options.aliasReuseCooldownMs;
  const nextLeaseStore = new Map<string, { sessionKey: string; lastSeenAt: number }>();
  for (const [runtimeKeyRaw, entryRaw] of Object.entries(leasesRaw as Record<string, unknown>)) {
    const runtimeKeyBase = typeof runtimeKeyRaw === 'string' ? runtimeKeyRaw.trim() : '';
    if (!runtimeKeyBase || !runtimeKeyBase.startsWith('antigravity.')) continue;
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const rawSessionKey =
      typeof (entryRaw as any).sessionKey === 'string' ? String((entryRaw as any).sessionKey).trim() : '';
    const lastSeenAt =
      typeof (entryRaw as any).lastSeenAt === 'number' && Number.isFinite((entryRaw as any).lastSeenAt)
        ? Math.floor((entryRaw as any).lastSeenAt as number)
        : 0;
    if (!rawSessionKey || !lastSeenAt) continue;
    if (cooldownMs > 0 && now - lastSeenAt >= cooldownMs) continue;

    // Backwards compatible: legacy lease keys were unscoped ("antigravity.<alias>").
    // Policy: only keep Gemini-scoped leases. Drop any non-gemini scoped entries.
    const hasExplicitScope = runtimeKeyBase.includes('::');
    if (hasExplicitScope && !runtimeKeyBase.endsWith('::gemini')) continue;
    const runtimeKey = hasExplicitScope ? runtimeKeyBase : buildAntigravityLeaseRuntimeKey(runtimeKeyBase);
    if (rawSessionKey.includes('::') && !rawSessionKey.endsWith('::gemini')) continue;
    const sessionKey = rawSessionKey.includes('::') ? rawSessionKey : buildScopedSessionKey(rawSessionKey);

    nextLeaseStore.set(runtimeKey, { sessionKey, lastSeenAt });
  }
  options.leaseStore.clear();
  for (const [key, val] of nextLeaseStore.entries()) {
    options.leaseStore.set(key, val);
  }
  options.persistence.loadedOnce = true;
  options.persistence.loadedMtimeMs = mtimeMs;
}

function flushAntigravityAliasLeaseStoreSync(options: {
  leaseStore: AntigravityAliasLeaseStore;
  persistence: AntigravityLeasePersistenceState;
  aliasReuseCooldownMs: number;
}): void {
  const filePath = resolveAntigravityAliasLeasePersistWritePath();
  if (!filePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (mkdirError) {
    logAliasLeaseNonBlockingError('flushAntigravityAliasLeaseStoreSync.mkdirSync', mkdirError, { filePath });
  }
  const now = Date.now();
  const cooldownMs = options.aliasReuseCooldownMs;
  const leases: Record<string, { sessionKey: string; lastSeenAt: number }> = {};
  for (const [runtimeKey, entry] of options.leaseStore.entries()) {
    if (!runtimeKey || !entry) continue;
    if (cooldownMs > 0 && now - entry.lastSeenAt >= cooldownMs) continue;
    if (!entry.sessionKey || !entry.lastSeenAt) continue;
    leases[runtimeKey] = { sessionKey: entry.sessionKey, lastSeenAt: entry.lastSeenAt };
  }
  try {
    const tmpPath = `${filePath}.tmp.${process.pid}.${now}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, updatedAt: now, leases }, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
    try {
      const stat = fs.statSync(filePath);
      const mtimeMs =
        typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime.getTime();
      options.persistence.loadedOnce = true;
      options.persistence.loadedMtimeMs = mtimeMs;
    } catch (statError) {
      logAliasLeaseNonBlockingError('flushAntigravityAliasLeaseStoreSync.statSync', statError, { filePath });
    }
  } catch (flushError) {
    logAliasLeaseNonBlockingError('flushAntigravityAliasLeaseStoreSync.writeRename', flushError, { filePath });
  }
}

function scheduleAntigravityAliasLeaseStoreFlush(options: {
  leaseStore: AntigravityAliasLeaseStore;
  persistence: AntigravityLeasePersistenceState;
  aliasReuseCooldownMs: number;
}): void {
  if (options.persistence.flushTimer) {
    return;
  }
  options.persistence.flushTimer = setTimeout(() => {
    options.persistence.flushTimer = null;
    flushAntigravityAliasLeaseStoreSync(options);
  }, 250);
  options.persistence.flushTimer.unref?.();
}

export function recordAntigravitySessionLease(options: {
  metadata: RouterMetadataInput;
  providerKey: string;
  sessionKey: string | undefined;
  providerRegistry: ProviderRegistry;
  leaseStore: AntigravityAliasLeaseStore;
  sessionAliasStore: AntigravitySessionAliasStore;
  persistence: AntigravityLeasePersistenceState;
  aliasReuseCooldownMs: number;
  commitSessionBinding: boolean;
  debug?: { log?: (...args: any[]) => void };
}): void {
  // Per-request runtime override: allow callers (e.g. servertool followups) to disable
  // Antigravity gemini session binding/lease without changing global config.
  try {
    const rt = (options.metadata as any)?.__rt;
    if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
      const disable = (rt as any).disableAntigravitySessionBinding;
      const mode = (rt as any).antigravitySessionBinding;
      if (disable === true || mode === false) {
        return;
      }
      if (typeof mode === 'string' && ['0', 'false', 'off', 'disabled', 'none'].includes(mode.trim().toLowerCase())) {
        return;
      }
    }
  } catch (metadataError) {
    logAliasLeaseNonBlockingError('recordAntigravitySessionLease.metadataOverrideParse', metadataError);
  }
  const sessionKey = options.sessionKey;
  if (!sessionKey) {
    return;
  }
  const runtimeKeyBase = extractRuntimeKey(options.providerKey);
  if (!runtimeKeyBase || !runtimeKeyBase.startsWith('antigravity.')) {
    return;
  }
  // Policy: antigravity alias leasing/binding applies only to Gemini models.
  const scope = resolveAntigravityLeaseScope(options.providerRegistry, options.providerKey);
  if (scope !== 'gemini') {
    return;
  }

  const scopedSessionKey = buildScopedSessionKey(sessionKey);
  const runtimeKey = buildAntigravityLeaseRuntimeKey(runtimeKeyBase);
  const now = Date.now();
  const cooldownMs = options.aliasReuseCooldownMs;
  const existing = options.leaseStore.get(runtimeKey);
  // Do not steal a lease from another active session. This prevents a "forced fallback" route
  // (e.g. default route bypass) from evicting the original session and causing churn.
  if (existing && existing.sessionKey !== scopedSessionKey && cooldownMs > 0 && now - existing.lastSeenAt < cooldownMs) {
    return;
  }

  options.leaseStore.set(runtimeKey, { sessionKey: scopedSessionKey, lastSeenAt: now });
  scheduleAntigravityAliasLeaseStoreFlush(options);

  if (!options.commitSessionBinding) {
    return;
  }
  // Bind sessionKey → alias runtimeKey so subsequent routing will prefer this alias.
  options.sessionAliasStore.set(scopedSessionKey, runtimeKey);
  try {
    options.debug?.log?.('[virtual-router][antigravity-session-binding] commit', {
      sessionKey: scopedSessionKey,
      runtimeKey,
      prev: existing?.sessionKey ?? null
    });
  } catch (debugLogError) {
    logAliasLeaseNonBlockingError('recordAntigravitySessionLease.debugLog', debugLogError, {
      runtimeKey
    });
  }
}
