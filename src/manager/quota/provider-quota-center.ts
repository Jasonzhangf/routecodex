export type QuotaReason = 'ok' | 'cooldown' | 'blacklist' | 'quotaDepleted' | 'fatal';

export type QuotaAuthType = 'apikey' | 'oauth' | 'unknown';

export interface StaticQuotaConfig {
  priorityTier?: number | null;
  rateLimitPerMinute?: number | null;
  tokenLimitPerMinute?: number | null;
  totalTokenLimit?: number | null;
  authType?: QuotaAuthType | null;
}

export interface QuotaState {
  providerKey: string;
  inPool: boolean;
  reason: QuotaReason;
  authType: QuotaAuthType;
  priorityTier: number;
  rateLimitPerMinute: number | null;
  tokenLimitPerMinute: number | null;
  totalTokenLimit: number | null;

  windowStartMs: number;
  requestsThisWindow: number;
  tokensThisWindow: number;
  totalTokensUsed: number;

  cooldownUntil: number | null;
  blacklistUntil: number | null;
  lastErrorSeries: ErrorSeries | null;
  consecutiveErrorCount: number;
}

export type ErrorSeries = 'E429' | 'E5XX' | 'ENET' | 'EFATAL' | 'EOTHER';

export interface ErrorEventForQuota {
  providerKey: string;
  code?: string | null;
  httpStatus?: number | null;
  fatal?: boolean | null;
  timestampMs?: number;
}

export interface SuccessEventForQuota {
  providerKey: string;
  usedTokens?: number | null;
  timestampMs?: number;
}

export interface UsageEventForQuota {
  providerKey: string;
  requestedTokens?: number | null;
  timestampMs?: number;
}

const WINDOW_DURATION_MS = 60_000;
const COOLDOWN_SCHEDULE_MS = [1 * 60_000, 3 * 60_000, 5 * 60_000] as const;
const BLACKLIST_MAX_MS = 6 * 60 * 60_000;
const BLACKLIST_1H_MS = 60 * 60_000;
const BLACKLIST_3H_MS = 3 * 60 * 60_000;
const BLACKLIST_THRESHOLD_DEFAULT = 3;

const NETWORK_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'];

export function createInitialQuotaState(
  providerKey: string,
  staticConfig?: StaticQuotaConfig,
  nowMs: number = Date.now()
): QuotaState {
  const priorityTier =
    staticConfig && typeof staticConfig.priorityTier === 'number'
      ? staticConfig.priorityTier
      : 100;
  const rateLimitPerMinute =
    staticConfig && typeof staticConfig.rateLimitPerMinute === 'number'
      ? staticConfig.rateLimitPerMinute
      : null;
  const tokenLimitPerMinute =
    staticConfig && typeof staticConfig.tokenLimitPerMinute === 'number'
      ? staticConfig.tokenLimitPerMinute
      : null;
  const totalTokenLimit =
    staticConfig && typeof staticConfig.totalTokenLimit === 'number'
      ? staticConfig.totalTokenLimit
      : null;
  const authType: QuotaAuthType =
    staticConfig && typeof staticConfig.authType === 'string' && staticConfig.authType.trim()
      ? (staticConfig.authType.trim() as QuotaAuthType)
      : 'unknown';

  return {
    providerKey,
    inPool: true,
    reason: 'ok',
    authType,
    priorityTier,
    rateLimitPerMinute,
    tokenLimitPerMinute,
    totalTokenLimit,
    windowStartMs: nowMs,
    requestsThisWindow: 0,
    tokensThisWindow: 0,
    totalTokensUsed: 0,
    cooldownUntil: null,
    blacklistUntil: null,
    lastErrorSeries: null,
    consecutiveErrorCount: 0
  };
}

export function normalizeErrorSeries(event: ErrorEventForQuota): ErrorSeries {
  if (event.fatal) {
    return 'EFATAL';
  }
  const status = typeof event.httpStatus === 'number' ? event.httpStatus : null;
  const rawCode = String(event.code || '').toUpperCase();

  if (status === 429 || rawCode.includes('429') || rawCode.includes('RATE') || rawCode.includes('QUOTA')) {
    return 'E429';
  }
  if (status && status >= 500) {
    return 'E5XX';
  }

  if (NETWORK_ERROR_CODES.some((code) => rawCode.includes(code))) {
    return 'ENET';
  }

  if (
    rawCode.includes('AUTH') ||
    rawCode.includes('UNAUTHORIZED') ||
    rawCode.includes('CONFIG') ||
    rawCode.includes('FATAL')
  ) {
    return 'EFATAL';
  }

  return 'EOTHER';
}

function computeCooldownMs(consecutive: number): number | null {
  if (consecutive <= 0) {
    return null;
  }
  const idx = Math.min(consecutive - 1, COOLDOWN_SCHEDULE_MS.length - 1);
  return COOLDOWN_SCHEDULE_MS[idx] ?? null;
}

type ErrorPolicy = {
  cooldownOnly: boolean;
  blacklistAfterConsecutive?: number;
  blacklistDurationMs?: number;
};

function resolveErrorPolicy(state: QuotaState, series: ErrorSeries): ErrorPolicy {
  // Fatal errors: immediate blacklist (max 6h).
  if (series === 'EFATAL') {
    return {
      cooldownOnly: false,
      blacklistAfterConsecutive: 1,
      blacklistDurationMs: BLACKLIST_MAX_MS
    };
  }

  // Network / upstream gateway errors: only backoff (1/3/5 minutes), keep repeating 5m.
  if (series === 'ENET' || series === 'E5XX') {
    return { cooldownOnly: true };
  }

  // 429 for API-key providers: 1/3/5 minute backoff, then 3h blacklist.
  if (series === 'E429' && state.authType === 'apikey') {
    return {
      cooldownOnly: false,
      blacklistAfterConsecutive: BLACKLIST_THRESHOLD_DEFAULT,
      blacklistDurationMs: BLACKLIST_3H_MS
    };
  }

  // 429 for OAuth/unknown providers: only backoff (do not long-blacklist here);
  // OAuth tokens may recover after refresh; quota-style providers should emit QUOTA_* events.
  if (series === 'E429') {
    return { cooldownOnly: true };
  }

  // Unknown / other errors: 1/3/5 minute backoff; after repeated series continues, blacklist 1h.
  return {
    cooldownOnly: false,
    blacklistAfterConsecutive: BLACKLIST_THRESHOLD_DEFAULT,
    blacklistDurationMs: BLACKLIST_1H_MS
  };
}

export function applyErrorEvent(
  state: QuotaState,
  event: ErrorEventForQuota,
  nowMs: number = event.timestampMs ?? Date.now()
): QuotaState {
  // 如果已经处于 fatal 黑名单且还在锁定窗口内，错误事件不再改变状态。
  if (state.reason === 'fatal' && state.blacklistUntil && nowMs < state.blacklistUntil) {
    return state;
  }

  const series = normalizeErrorSeries(event);

  // 不可恢复错误：直接 6 小时锁定。
  if (series === 'EFATAL') {
    return {
      ...state,
      inPool: false,
      reason: 'fatal',
      blacklistUntil: nowMs + BLACKLIST_MAX_MS,
      cooldownUntil: null,
      lastErrorSeries: series,
      consecutiveErrorCount: state.consecutiveErrorCount + 1
    };
  }

  const sameSeries = state.lastErrorSeries === series;
  const nextCount = sameSeries ? state.consecutiveErrorCount + 1 : 1;

  const policy = resolveErrorPolicy(state, series);
  const shouldBlacklist =
    !policy.cooldownOnly &&
    typeof policy.blacklistAfterConsecutive === 'number' &&
    Number.isFinite(policy.blacklistAfterConsecutive) &&
    policy.blacklistAfterConsecutive > 0 &&
    nextCount >= policy.blacklistAfterConsecutive &&
    typeof policy.blacklistDurationMs === 'number' &&
    Number.isFinite(policy.blacklistDurationMs) &&
    policy.blacklistDurationMs > 0;

  if (shouldBlacklist) {
    return {
      ...state,
      inPool: false,
      reason: 'blacklist',
      cooldownUntil: null,
      blacklistUntil: nowMs + (policy.blacklistDurationMs as number),
      lastErrorSeries: series,
      consecutiveErrorCount: nextCount
    };
  }

  const cooldownMs = computeCooldownMs(nextCount);
  const cooldownUntil = cooldownMs ? nowMs + cooldownMs : null;

  return {
    ...state,
    inPool: false,
    reason: 'cooldown',
    cooldownUntil,
    lastErrorSeries: series,
    consecutiveErrorCount: nextCount
  };
}

export function applySuccessEvent(
  state: QuotaState,
  event: SuccessEventForQuota,
  nowMs: number = event.timestampMs ?? Date.now()
): QuotaState {
  const usedTokens = typeof event.usedTokens === 'number' && event.usedTokens > 0 ? event.usedTokens : 0;
  const totalTokensUsed = state.totalTokensUsed + usedTokens;

  // fatal 黑名单在锁定期内不自动恢复，成功事件只更新统计信息。
  if (state.reason === 'fatal' && state.blacklistUntil && nowMs < state.blacklistUntil) {
    return {
      ...state,
      totalTokensUsed,
      lastErrorSeries: null,
      consecutiveErrorCount: 0
    };
  }

  const withinBlacklist =
    state.blacklistUntil !== null && nowMs < state.blacklistUntil;

  const clearedCooldown =
    state.cooldownUntil !== null && nowMs >= state.cooldownUntil;

  let nextReason: QuotaReason = state.reason;
  let nextInPool = state.inPool;
  let nextCooldownUntil = state.cooldownUntil;

  if (!withinBlacklist) {
    // 非黑名单情况下，成功会把冷却结束的 provider 恢复为 ok。
    if (clearedCooldown || state.reason === 'cooldown') {
      nextReason = 'ok';
      nextInPool = true;
      nextCooldownUntil = null;
    }
    if (state.reason === 'quotaDepleted' && !state.totalTokenLimit) {
      // 软配额耗尽：窗口翻转后由 tickWindow 恢复；成功本身不改变。
      nextReason = state.reason;
      nextInPool = state.inPool;
    }
  }

  return {
    ...state,
    totalTokensUsed,
    reason: nextReason,
    inPool: nextInPool,
    cooldownUntil: nextCooldownUntil,
    lastErrorSeries: null,
    consecutiveErrorCount: 0
  };
}

export function applyUsageEvent(
  state: QuotaState,
  event: UsageEventForQuota,
  nowMs: number = event.timestampMs ?? Date.now()
): QuotaState {
  const requestedTokens =
    typeof event.requestedTokens === 'number' && event.requestedTokens > 0
      ? event.requestedTokens
      : 0;

  let next = tickQuotaStateTime(state, nowMs);

  const requestsThisWindow = next.requestsThisWindow + 1;
  const tokensThisWindow = next.tokensThisWindow + requestedTokens;
  const totalTokensUsed = next.totalTokensUsed + requestedTokens;

  next = {
    ...next,
    requestsThisWindow,
    tokensThisWindow,
    totalTokensUsed
  };

  let quotaExceeded = false;

  if (next.rateLimitPerMinute !== null && next.rateLimitPerMinute >= 0) {
    if (requestsThisWindow > next.rateLimitPerMinute) {
      quotaExceeded = true;
    }
  }

  if (next.tokenLimitPerMinute !== null && next.tokenLimitPerMinute >= 0) {
    if (tokensThisWindow > next.tokenLimitPerMinute) {
      quotaExceeded = true;
    }
  }

  if (next.totalTokenLimit !== null && next.totalTokenLimit >= 0) {
    if (totalTokensUsed > next.totalTokenLimit) {
      quotaExceeded = true;
    }
  }

  if (!quotaExceeded) {
    return next;
  }

  return {
    ...next,
    inPool: false,
    reason: 'quotaDepleted'
  };
}

export function tickQuotaStateTime(state: QuotaState, nowMs: number): QuotaState {
  let next = state;

  // Guard: persisted snapshots may carry inconsistent flags (e.g. `inPool: true` while cooldown is still active)
  // due to legacy window reset behavior. Ensure active cooldown/blacklist always removes the provider from pool.
  const withinBlacklist = next.blacklistUntil !== null && nowMs < next.blacklistUntil;
  const withinCooldown = next.cooldownUntil !== null && nowMs < next.cooldownUntil;
  if ((withinBlacklist || withinCooldown) && next.inPool) {
    next = {
      ...next,
      inPool: false,
      reason:
        withinBlacklist
          ? 'blacklist'
          : withinCooldown && next.reason === 'ok'
          ? 'cooldown'
          : next.reason
    };
  }

  // 冷却与黑名单窗口到期处理。
  if (next.blacklistUntil !== null && nowMs >= next.blacklistUntil) {
    next = {
      ...next,
      blacklistUntil: null,
      cooldownUntil: null,
      inPool: true,
      reason: 'ok',
      lastErrorSeries: null,
      consecutiveErrorCount: 0
    };
  } else if (next.cooldownUntil !== null && nowMs >= next.cooldownUntil) {
    next = {
      ...next,
      cooldownUntil: null,
      inPool: true,
      reason: next.reason === 'cooldown' || next.reason === 'quotaDepleted' ? 'ok' : next.reason
    };
  }

  // 配额时间窗口翻转。
  if (nowMs - next.windowStartMs >= WINDOW_DURATION_MS) {
    const resetState: QuotaState = {
      ...next,
      windowStartMs: nowMs,
      requestsThisWindow: 0,
      tokensThisWindow: 0
    };

    if (resetState.reason === 'quotaDepleted') {
      const hasHardTotalLimit =
        resetState.totalTokenLimit !== null &&
        resetState.totalTokenLimit >= 0 &&
        resetState.totalTokensUsed > resetState.totalTokenLimit;
      const stillCoolingDown = resetState.cooldownUntil !== null && nowMs < resetState.cooldownUntil;
      const stillBlacklisted = resetState.blacklistUntil !== null && nowMs < resetState.blacklistUntil;
      if (!hasHardTotalLimit && !stillCoolingDown && !stillBlacklisted) {
        return {
          ...resetState,
          inPool: true,
          reason: 'ok'
        };
      }
    }
    return resetState;
  }

  return next;
}
