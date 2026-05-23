import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';
import {
  applyErrorEvent as applyQuotaErrorEvent,
  createInitialQuotaState,
  type ErrorEventForQuota,
  type QuotaState,
  type StaticQuotaConfig
} from '../../quota/provider-quota-center.js';
import { appendProviderErrorEvent, saveProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';
import { canonicalizeProviderKey } from './provider-key-normalization.js';
import {
  capAutoCooldownMs,
  capAutoCooldownUntil,
  extractVirtualRouterSeriesCooldown,
  parseQuotaResetDelayMs,
  parseApikeyDailyResetAtMs,
  computeDailyResetUntilMs
} from './provider-quota-daemon.cooldown.js';
import { isModelCapacityExhausted429, ProviderModelBackoffTracker } from './provider-quota-daemon.model-backoff.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import {
  extractProviderKey,
  isAkBlocked434,
  isFatalForQuota
} from './provider-quota-daemon.error-helpers.js';


function logProviderQuotaDaemonEventNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[provider-quota-daemon.events] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`
    );
  } catch {
    void 0;
  }
}

export type ProviderQuotaDaemonEventContext = {
  quotaStates: Map<string, QuotaState>;
  staticConfigs: Map<string, StaticQuotaConfig>;
  quotaRoutingEnabled: boolean;
  modelBackoff: ProviderModelBackoffTracker;
  schedulePersist(nowMs: number): void;
  toSnapshotObject(): Record<string, QuotaState>;
};

type WindsurfRateLimitBurstEvent = {
  time: number;
  modelKey: string;
  providerKey: string;
};

function resolveWindsurfModelScopeKey(providerKey: string): string | null {
  const raw = typeof providerKey === 'string' ? providerKey.trim().toLowerCase() : '';
  if (!raw.startsWith('windsurf.')) {
    return null;
  }
  const parts = raw.split('.');
  if (parts.length < 3) {
    return null;
  }
  return parts.slice(2).join('.');
}

function collectWindsurfModelSiblingKeys(
  ctx: Pick<ProviderQuotaDaemonEventContext, 'quotaStates' | 'staticConfigs'>,
  modelKey: string,
): string[] {
  const normalizedModelKey = String(modelKey || '').trim().toLowerCase();
  const out = new Set<string>();
  const matchKey = (value: string) => {
    const scoped = resolveWindsurfModelScopeKey(value);
    if (scoped === normalizedModelKey) {
      out.add(String(value || '').trim().toLowerCase());
    }
  };
  for (const key of ctx.quotaStates.keys()) {
    matchKey(key);
  }
  for (const key of ctx.staticConfigs.keys()) {
    matchKey(key);
  }
  return Array.from(out);
}

function recordWindsurfRateLimitBurstAndReadCooldown(args: {
  ctx: ProviderQuotaDaemonEventContext;
  providerKey: string;
  nowMs: number;
}): { hit: boolean; cooldownMs: number; siblingKeys: string[] } {
  const modelKey = resolveWindsurfModelScopeKey(args.providerKey);
  if (!modelKey) {
    return { hit: false, cooldownMs: 30_000, siblingKeys: [] };
  }
  const ctxRecord = args.ctx as ProviderQuotaDaemonEventContext & {
    __windsurfRateLimitEvents?: WindsurfRateLimitBurstEvent[];
  };
  const windowMs = 8_000;
  const threshold = 3;
  const cooldownMs = 30_000;
  const nextEvents = Array.isArray(ctxRecord.__windsurfRateLimitEvents)
    ? ctxRecord.__windsurfRateLimitEvents
    : [];
  nextEvents.push({
    time: args.nowMs,
    modelKey,
    providerKey: args.providerKey,
  });
  const cutoff = args.nowMs - windowMs;
  ctxRecord.__windsurfRateLimitEvents = nextEvents.filter((entry) => entry.time >= cutoff);
  const sameModelCount = new Set(
    ctxRecord.__windsurfRateLimitEvents
      .filter((entry) => entry.modelKey === modelKey)
      .map((entry) => entry.providerKey),
  ).size;
  return {
    hit: sameModelCount >= threshold,
    cooldownMs,
    siblingKeys: collectWindsurfModelSiblingKeys(args.ctx, modelKey),
  };
}

export async function handleProviderQuotaErrorEvent(
  ctx: ProviderQuotaDaemonEventContext,
  event: ProviderErrorEvent
): Promise<void> {
  if (!ctx.quotaRoutingEnabled) {
    return;
  }

  if (!event) {
    return;
  }
  const code = typeof event.code === 'string' ? event.code : '';

  const extracted = extractProviderKey(event);
  const providerKey = extracted ? canonicalizeProviderKey(extracted) : null;
  if (!providerKey) {
    return;
  }

  const nowMs =
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) && event.timestamp > 0
      ? event.timestamp
      : Date.now();

  const previous =
    ctx.quotaStates.get(providerKey) ??
    createInitialQuotaState(providerKey, ctx.staticConfigs.get(providerKey), nowMs);

  const detailsRecord =
    event.details && typeof event.details === 'object'
      ? (event.details as Record<string, unknown>)
      : {};
  const weeklyQuotaExhausted =
    code === 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED'
    || String(detailsRecord.quotaScope || '').trim().toLowerCase() === 'weekly'
    || String(detailsRecord.quotaReason || '').trim().toLowerCase() === 'windsurf_weekly_exhausted';

  if (weeklyQuotaExhausted) {
    const rawCooldownMs = detailsRecord.cooldownOverrideMs;
    const resetUntil = computeDailyResetUntilMs({
      nowMs,
      resetTime: '00:00',
      defaultLocalHour: 0,
      defaultLocalMinute: 0
    });
    const cooldownMs =
      typeof rawCooldownMs === 'number' && Number.isFinite(rawCooldownMs) && rawCooldownMs > 0
        ? rawCooldownMs
        : (resetUntil && resetUntil > nowMs ? resetUntil - nowMs : 24 * 60 * 60_000);
    const nextState: QuotaState = {
      ...previous,
      inPool: false,
      reason: 'blacklist',
      cooldownUntil: null,
      cooldownKeepsPool: undefined,
      blacklistUntil: nowMs + cooldownMs,
      lastErrorSeries: 'E429',
      lastErrorCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
      lastErrorAtMs: nowMs,
      consecutiveErrorCount:
        typeof previous.consecutiveErrorCount === 'number' && previous.consecutiveErrorCount > 0
          ? previous.consecutiveErrorCount + 1
          : 1
    };
    const aliasPrefix = resolveWindsurfAliasPrefix(providerKey);
    const familyKeys = aliasPrefix ? collectWindsurfAliasFamilyKeys(ctx, aliasPrefix) : [];
    if (familyKeys.length > 0) {
      for (const familyKey of familyKeys) {
        const canonicalFamilyKey = canonicalizeProviderKey(familyKey);
        const prevFamily =
          ctx.quotaStates.get(canonicalFamilyKey) ??
          createInitialQuotaState(canonicalFamilyKey, ctx.staticConfigs.get(canonicalFamilyKey), nowMs);
        const nextFamily: QuotaState = {
          ...prevFamily,
          inPool: false,
          reason: 'blacklist',
          cooldownUntil: null,
          cooldownKeepsPool: undefined,
          blacklistUntil: nowMs + cooldownMs,
          lastErrorSeries: 'E429',
          lastErrorCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
          lastErrorAtMs: nowMs,
          consecutiveErrorCount:
            typeof prevFamily.consecutiveErrorCount === 'number' && prevFamily.consecutiveErrorCount > 0
              ? prevFamily.consecutiveErrorCount + 1
              : 1
        };
        ctx.quotaStates.set(canonicalFamilyKey, nextFamily);
      }
    } else {
      ctx.quotaStates.set(providerKey, nextState);
    }
    ctx.schedulePersist(nowMs);
    return;
  }

  if (isAkBlocked434(event)) {
    const blacklistMs = readPositiveNumberFromEnv('ROUTECODEX_434_BLACKLIST_MS', 30 * 24 * 60 * 60_000);
    const nextState: QuotaState = {
      ...previous,
      inPool: false,
      reason: 'blacklist',
      blacklistUntil: nowMs + blacklistMs,
      cooldownUntil: null,
      lastErrorSeries: 'EFATAL',
      lastErrorCode: 'AK_BLOCKED_434',
      lastErrorAtMs: nowMs,
      consecutiveErrorCount:
        typeof previous.consecutiveErrorCount === 'number' && previous.consecutiveErrorCount > 0
          ? previous.consecutiveErrorCount + 1
          : 1
    };
    ctx.quotaStates.set(providerKey, nextState);
    ctx.schedulePersist(nowMs);

    const tsIso = new Date(nowMs).toISOString();
    try {
      await appendProviderErrorEvent({
        ts: tsIso,
        providerKey,
        code: typeof event.code === 'string' ? event.code : 'AK_BLOCKED_434',
        httpStatus: typeof event.status === 'number' ? event.status : undefined,
        message: event.message,
        details: {
          stage: event.stage,
          routeName: (event.runtime as { routeName?: string }).routeName,
          entryEndpoint: (event.runtime as { entryEndpoint?: string }).entryEndpoint,
          authIssue: { kind: 'ak_blocked_434', blacklistUntil: nowMs + blacklistMs }
        }
      });
    } catch (appendError) {
      logProviderQuotaDaemonEventNonBlockingError('ak_blocked_434.appendProviderErrorEvent', appendError, {
        providerKey
      });
    }
    return;
  }

  // Manual/operator blacklist is rigid: do not override it with automated error/quota signals.
  if (previous.reason === 'blacklist' && previous.blacklistUntil && nowMs < previous.blacklistUntil) {
    return;
  }

  // Apikey providers: HTTP 402 means daily spending quota exhausted.
  // Default policy: blacklist until the next daily reset time:
  // - Prefer upstream `resetAt` when present in error payload.
  // - Otherwise use configured `apikeyDailyResetTime` (or default 12:00 local).
  if (typeof event.status === 'number' && event.status === 402 && previous.authType === 'apikey') {
    const resetAtMs = parseApikeyDailyResetAtMs(event);
    const staticCfg = ctx.staticConfigs.get(providerKey) as unknown as { apikeyDailyResetTime?: unknown } | undefined;
    const apikeyDailyResetTime =
      staticCfg && typeof staticCfg.apikeyDailyResetTime === 'string' ? staticCfg.apikeyDailyResetTime.trim() : '';
    const until =
      resetAtMs && resetAtMs > nowMs
        ? resetAtMs
        : computeDailyResetUntilMs({
            nowMs,
            resetTime: apikeyDailyResetTime || null,
            defaultLocalHour: 12,
            defaultLocalMinute: 0
          });
    if (until && until > nowMs) {
      const nextState: QuotaState = {
        ...previous,
        inPool: false,
        reason: 'blacklist',
        blacklistUntil: until,
        cooldownUntil: null,
        lastErrorSeries: null,
        lastErrorCode: null,
        lastErrorAtMs: null,
        consecutiveErrorCount: 0
      };
      ctx.quotaStates.set(providerKey, nextState);
      ctx.schedulePersist(nowMs);
      return;
    }
  }

  // Upstream capacity exhaustion is not quota depletion. Cool down the entire model series immediately
  // so the router can try other models/providers instead of hammering 429s.
  if (isModelCapacityExhausted429(event)) {
    ctx.modelBackoff.recordCapacity429(providerKey, event, nowMs);
    const cooldownUntil =
      ctx.modelBackoff.getActiveCooldownUntil(providerKey, nowMs) ??
      (nowMs + 15_000);
    const errorForQuota: ErrorEventForQuota = {
      providerKey,
      httpStatus: typeof event.status === 'number' ? event.status : undefined,
      code: typeof event.code === 'string' ? event.code : undefined,
      fatal: false,
      timestampMs: nowMs
    };
    const applied = applyQuotaErrorEvent(previous, errorForQuota, nowMs);
    const nextState: QuotaState = {
      ...applied,
      inPool: true,
      reason: 'cooldown',
      cooldownUntil,
      cooldownKeepsPool: true
    };
    ctx.quotaStates.set(providerKey, nextState);
    ctx.schedulePersist(nowMs);
    return;
  }

  // QUOTA_* 属于“确定性配额信号”，不进入错误 series 统计。
  if (code === 'QUOTA_DEPLETED') {
    const detailCarrier = (event.details && typeof event.details === 'object') ? (event.details as Record<string, unknown>) : {};
    const raw = detailCarrier.virtualRouterQuotaDepleted;
    const cooldownMs =
      raw && typeof raw === 'object' && typeof (raw as { cooldownMs?: unknown }).cooldownMs === 'number'
        ? ((raw as { cooldownMs?: number }).cooldownMs as number)
        : undefined;
    const ttl =
      typeof cooldownMs === 'number' && Number.isFinite(cooldownMs) && cooldownMs > 0
        ? cooldownMs
        : undefined;
    const cappedTtl = capAutoCooldownMs(ttl);
    const nextCooldownUntil = cappedTtl ? nowMs + cappedTtl : previous.cooldownUntil;
    const existingCooldownUntil = previous.cooldownUntil;
    const cooldownUntil =
      typeof existingCooldownUntil === 'number' && typeof nextCooldownUntil === 'number' && existingCooldownUntil > nextCooldownUntil
        ? existingCooldownUntil
        : nextCooldownUntil;
    const nextState: QuotaState = {
      ...previous,
      inPool: false,
      reason: 'quotaDepleted',
      cooldownUntil
    };
    ctx.quotaStates.set(providerKey, nextState);
    ctx.schedulePersist(nowMs);
    return;
  }
  if (code === 'QUOTA_RECOVERY') {
    const withinBlacklist =
      previous.blacklistUntil !== null && nowMs < previous.blacklistUntil;
    // QUOTA_RECOVERY only flips providers that are waiting on an explicit quota snapshot,
    // and must not override active cooldown windows caused by real upstream failures.
    const canRecover = previous.reason === 'quotaDepleted';
    if (canRecover && !withinBlacklist) {
      const nextState: QuotaState = {
        ...previous,
        inPool: true,
        reason: 'ok',
        cooldownUntil: null
      };
      ctx.quotaStates.set(providerKey, nextState);
      ctx.schedulePersist(nowMs);
    }
    return;
  }

  // Gemini-family quota exhausted errors often carry quota reset delay.
  // When present, treat as deterministic quota depletion signal rather than generic 429 backoff/blacklist.
  if (typeof event.status === 'number' && event.status === 429) {
    const seriesCooldown = extractVirtualRouterSeriesCooldown(event, nowMs);
    if (seriesCooldown) {
      const withinBlacklist =
        previous.blacklistUntil !== null && nowMs < previous.blacklistUntil;
      // Do not override an active blacklist window (manual ops or policy).
      if (withinBlacklist) {
        return;
      }
      const isCapacityCooldown =
        typeof seriesCooldown.source === 'string' && seriesCooldown.source.toLowerCase().includes('capacity');
      const until = capAutoCooldownUntil(seriesCooldown.until, nowMs);
      const existingCooldownUntil = previous.cooldownUntil;
      const cooldownUntil =
        typeof existingCooldownUntil === 'number' && existingCooldownUntil > until
          ? existingCooldownUntil
          : until;
      const nextState: QuotaState = {
        ...previous,
        inPool: isCapacityCooldown ? true : false,
        reason: isCapacityCooldown ? 'cooldown' : 'quotaDepleted',
        cooldownUntil,
        lastErrorSeries: null,
        lastErrorCode: null,
        lastErrorAtMs: null,
        consecutiveErrorCount: 0,
        ...(isCapacityCooldown
          ? { cooldownKeepsPool: true }
          : {
              blacklistUntil: null,
              // deterministic quota signals should clear blacklist to avoid sticky long locks
              // when upstream provides explicit reset delay.
            })
      };
      ctx.quotaStates.set(providerKey, nextState);
      ctx.schedulePersist(nowMs);
      return;
    }
    const runtime = event.runtime as { providerId?: unknown; providerProtocol?: unknown } | undefined;
    const providerIdRaw = runtime && typeof runtime.providerId === 'string' ? runtime.providerId.trim().toLowerCase() : '';
    if (providerIdRaw === 'windsurf') {
      const burst = recordWindsurfRateLimitBurstAndReadCooldown({
        ctx,
        providerKey,
        nowMs,
      });
      if (burst.hit) {
        const until = nowMs + burst.cooldownMs;
        for (const siblingKey of burst.siblingKeys) {
          const prevSibling =
            ctx.quotaStates.get(siblingKey) ??
            createInitialQuotaState(siblingKey, ctx.staticConfigs.get(siblingKey), nowMs);
          const existingCooldownUntil = prevSibling.cooldownUntil;
          const cooldownUntil =
            typeof existingCooldownUntil === 'number' && existingCooldownUntil > until
              ? existingCooldownUntil
              : until;
          ctx.quotaStates.set(siblingKey, {
            ...prevSibling,
            inPool: false,
            reason: 'cooldown',
            cooldownUntil,
            cooldownKeepsPool: undefined,
          });
        }
        ctx.schedulePersist(nowMs);
        return;
      }
    }
    const isQuotaProvider = providerIdRaw === 'gemini';
    if (isQuotaProvider) {
      const ttl = parseQuotaResetDelayMs(event);
      if (ttl && ttl > 0) {
        const capped = capAutoCooldownMs(ttl);
	        const nextState: QuotaState = {
	          ...previous,
	          inPool: false,
	          reason: 'quotaDepleted',
	          cooldownUntil: nowMs + (capped ?? ttl),
	          blacklistUntil: null,
	          lastErrorSeries: null,
	          lastErrorCode: null,
	          lastErrorAtMs: null,
	          consecutiveErrorCount: 0
	        };
        ctx.quotaStates.set(providerKey, nextState);
        ctx.schedulePersist(nowMs);
        return;
      }
    }
  }

  const errorForQuota: ErrorEventForQuota = {
    providerKey,
    httpStatus: typeof event.status === 'number' ? event.status : undefined,
    code: typeof event.code === 'string' ? event.code : undefined,
    message: typeof event.message === 'string' ? event.message : undefined,
    fatal: isFatalForQuota(event),
    timestampMs: nowMs
  };

  const appliedState = applyQuotaErrorEvent(previous, errorForQuota, nowMs);
  const errorClassification =
    typeof detailsRecord.errorClassification === 'string'
      ? detailsRecord.errorClassification.trim().toLowerCase()
      : '';
  const routePoolSizeRaw = detailsRecord.routePoolSize;
  const routePoolSize =
    typeof routePoolSizeRaw === 'number' && Number.isFinite(routePoolSizeRaw)
      ? Math.max(0, Math.floor(routePoolSizeRaw))
      : 0;
  const shouldEvictFromPool =
    errorClassification === 'unrecoverable'
    && appliedState.consecutiveErrorCount >= 3
    && routePoolSize > 1;
  const nextState: QuotaState =
    shouldEvictFromPool
      ? {
          ...appliedState,
          inPool: false,
          reason: 'cooldown',
          cooldownKeepsPool: undefined
        }
      : {
          ...appliedState,
          inPool: true,
          reason: appliedState.reason === 'ok' ? 'ok' : 'cooldown',
          cooldownKeepsPool: appliedState.reason === 'ok' ? undefined : true
        };
  ctx.quotaStates.set(providerKey, nextState);

  const tsIso = new Date(nowMs).toISOString();
  try {
    await appendProviderErrorEvent({
      ts: tsIso,
      providerKey,
      code: typeof errorForQuota.code === 'string' ? errorForQuota.code : undefined,
      httpStatus: typeof errorForQuota.httpStatus === 'number' ? errorForQuota.httpStatus : undefined,
      message: event.message,
      details: {
        stage: event.stage,
        routeName: (event.runtime as { routeName?: string }).routeName,
        entryEndpoint: (event.runtime as { entryEndpoint?: string }).entryEndpoint
      }
    });
  } catch (appendError) {
    logProviderQuotaDaemonEventNonBlockingError('appendProviderErrorEvent', appendError, {
      providerKey
    });
  }

  try {
    await saveProviderQuotaSnapshot(ctx.toSnapshotObject(), new Date(nowMs));
  } catch (snapshotError) {
    logProviderQuotaDaemonEventNonBlockingError('saveProviderQuotaSnapshot', snapshotError, {
      providerKey
    });
  }
}

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

function collectWindsurfAliasFamilyKeys(
  ctx: Pick<ProviderQuotaDaemonEventContext, 'quotaStates' | 'staticConfigs'>,
  aliasPrefix: string
): string[] {
  const normalizedPrefix = `${aliasPrefix}.`;
  const keys = new Set<string>();
  keys.add(aliasPrefix);
  for (const key of ctx.quotaStates.keys()) {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized === aliasPrefix || normalized.startsWith(normalizedPrefix)) {
      keys.add(normalized);
    }
  }
  for (const key of ctx.staticConfigs.keys()) {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized === aliasPrefix || normalized.startsWith(normalizedPrefix)) {
      keys.add(normalized);
    }
  }
  return Array.from(keys);
}

function readPositiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
