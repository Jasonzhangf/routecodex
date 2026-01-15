export type QuotaReason = 'ok' | 'cooldown' | 'blacklist' | 'quotaDepleted' | 'fatal';

export interface StaticQuotaConfig {
  priorityTier?: number | null;
  rateLimitPerMinute?: number | null;
  tokenLimitPerMinute?: number | null;
  totalTokenLimit?: number | null;
}

export interface QuotaState {
  providerKey: string;
  inPool: boolean;
  reason: QuotaReason;
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
const COOLDOWN_1_MS = 1 * 60_000;
const COOLDOWN_2_MS = 3 * 60_000;
const COOLDOWN_3_MS = 5 * 60_000;
const BLACKLIST_MS = 6 * 60 * 60_000;

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

  return {
    providerKey,
    inPool: true,
    reason: 'ok',
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
  if (consecutive === 1) {
    return COOLDOWN_1_MS;
  }
  if (consecutive === 2) {
    return COOLDOWN_2_MS;
  }
  if (consecutive >= 3) {
    return COOLDOWN_3_MS;
  }
  return null;
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
      blacklistUntil: nowMs + BLACKLIST_MS,
      cooldownUntil: null,
      lastErrorSeries: series,
      consecutiveErrorCount: state.consecutiveErrorCount + 1
    };
  }

  const sameSeries = state.lastErrorSeries === series;
  const nextCount = sameSeries ? state.consecutiveErrorCount + 1 : 1;

  // 连续三次同类错误：锁定 6 小时。
  if (nextCount >= 3) {
    return {
      ...state,
      inPool: false,
      reason: 'blacklist',
      cooldownUntil: null,
      blacklistUntil: nowMs + BLACKLIST_MS,
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
      reason: next.reason === 'cooldown' ? 'ok' : next.reason
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

    if (resetState.reason === 'quotaDepleted' && !resetState.totalTokenLimit) {
      return {
        ...resetState,
        inPool: true,
        reason: 'ok'
      };
    }
    return resetState;
  }

  return next;
}

