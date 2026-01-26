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
  parseQuotaResetDelayMs
} from './provider-quota-daemon.cooldown.js';
import { isModelCapacityExhausted429, ProviderModelBackoffTracker } from './provider-quota-daemon.model-backoff.js';

export type ProviderQuotaDaemonEventContext = {
  quotaStates: Map<string, QuotaState>;
  staticConfigs: Map<string, StaticQuotaConfig>;
  quotaRoutingEnabled: boolean;
  modelBackoff: ProviderModelBackoffTracker;
  schedulePersist(nowMs: number): void;
  toSnapshotObject(): Record<string, QuotaState>;
};

function extractAntigravityAlias(providerKey: string): string | null {
  const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!raw) {
    return null;
  }
  const parts = raw.split('.').filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[0]?.toLowerCase() !== 'antigravity') {
    return null;
  }
  return parts[1] ? parts[1].trim() : null;
}

function applyAntigravityAccountCooldown(
  ctx: ProviderQuotaDaemonEventContext,
  alias: string,
  cooldownUntil: number,
  nowMs: number,
  sourceKey?: string
): void {
  if (!alias) {
    return;
  }
  let touched = false;
  for (const [key, state] of ctx.quotaStates.entries()) {
    if (!key.startsWith('antigravity.')) {
      continue;
    }
    const keyAlias = extractAntigravityAlias(key);
    if (!keyAlias || keyAlias !== alias) {
      continue;
    }
    if (sourceKey && key === sourceKey) {
      continue;
    }
    if (state.reason === 'blacklist' && state.blacklistUntil && nowMs < state.blacklistUntil) {
      continue;
    }
    const existing = state.cooldownUntil;
    const nextCooldownUntil =
      typeof existing === 'number' && Number.isFinite(existing) && existing > cooldownUntil
        ? existing
        : cooldownUntil;
    const nextState: QuotaState = {
      ...state,
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: nextCooldownUntil
    };
    ctx.quotaStates.set(key, nextState);
    touched = true;
  }
  if (touched) {
    ctx.schedulePersist(nowMs);
  }
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
  const runtime = event.runtime as { providerId?: unknown } | undefined;
  const providerIdRaw =
    runtime && typeof runtime.providerId === 'string' ? runtime.providerId.trim().toLowerCase() : '';

  const previous =
    ctx.quotaStates.get(providerKey) ??
    createInitialQuotaState(providerKey, ctx.staticConfigs.get(providerKey), nowMs);

  // Manual/operator blacklist is rigid: do not override it with automated error/quota signals.
  if (previous.reason === 'blacklist' && previous.blacklistUntil && nowMs < previous.blacklistUntil) {
    return;
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
      inPool: false,
      reason: 'cooldown',
      cooldownUntil
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
    // QUOTA_RECOVERY should only flip providers that are waiting on an explicit quota snapshot:
    // - previously quota-depleted, or
    // - antigravity oauth "untracked" initial state (cooldown with no timers / no error series).
    //
    // It must NOT override active cooldown windows caused by real upstream failures
    // (e.g. MODEL_CAPACITY_EXHAUSTED short backoff), otherwise the pool will keep hammering 429s.
	    const isUntrackedAntigravityOauthGate =
	      previous.reason === 'cooldown' &&
	      previous.cooldownUntil === null &&
	      previous.blacklistUntil === null &&
	      previous.lastErrorSeries === null &&
	      previous.lastErrorCode === null &&
	      previous.lastErrorAtMs === null &&
	      previous.consecutiveErrorCount === 0;
    const canRecover = previous.reason === 'quotaDepleted' || isUntrackedAntigravityOauthGate;
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
	        inPool: false,
	        reason: isCapacityCooldown ? 'cooldown' : 'quotaDepleted',
	        cooldownUntil,
	        lastErrorSeries: null,
	        lastErrorCode: null,
	        lastErrorAtMs: null,
	        consecutiveErrorCount: 0,
	        ...(isCapacityCooldown
	          ? {}
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
    const isQuotaProvider = providerIdRaw === 'antigravity' || providerIdRaw === 'gemini-cli';
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
    fatal: isFatalForQuota(event),
    timestampMs: nowMs
  };

  const nextState = applyQuotaErrorEvent(previous, errorForQuota, nowMs);
  if (
    typeof event.status === 'number' &&
    event.status === 429 &&
    providerIdRaw === 'antigravity' &&
    typeof nextState.cooldownUntil === 'number' &&
    nextState.cooldownUntil > nowMs
  ) {
    const alias = extractAntigravityAlias(providerKey);
    if (alias) {
      applyAntigravityAccountCooldown(ctx, alias, nextState.cooldownUntil, nowMs, providerKey);
    }
  }
  ctx.quotaStates.set(providerKey, nextState);
  ctx.schedulePersist(nowMs);

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
  } catch {
    // logging failure is non-fatal
  }

  try {
    await saveProviderQuotaSnapshot(ctx.toSnapshotObject(), new Date(nowMs));
  } catch {
    // best-effort persistence only
  }
}

function extractProviderKey(event: ProviderErrorEvent): string | null {
  const runtime = event.runtime as { providerKey?: unknown; target?: unknown } | undefined;
  const direct =
    runtime && typeof runtime.providerKey === 'string' && runtime.providerKey.trim()
      ? runtime.providerKey.trim()
      : null;
  if (direct) {
    return direct;
  }
  const target = runtime && runtime.target;
  if (target && typeof target === 'object') {
    const targetKey = (target as { providerKey?: unknown }).providerKey;
    if (typeof targetKey === 'string' && targetKey.trim()) {
      return targetKey.trim();
    }
  }
  return null;
}

function isFatalForQuota(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  const code = typeof event.code === 'string' ? event.code.toUpperCase() : '';
  const stage = typeof event.stage === 'string' ? event.stage.toLowerCase() : '';

  if (status === 401 || status === 402 || status === 403) {
    return true;
  }
  if (code.includes('AUTH') || code.includes('UNAUTHORIZED')) {
    return true;
  }
  if (code.includes('CONFIG')) {
    return true;
  }
  if (stage.includes('compat')) {
    return true;
  }
  if (event.recoverable === false && status !== undefined && status >= 500) {
    return true;
  }
  return false;
}
