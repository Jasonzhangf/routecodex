export type QuotaReason = 'ok' | 'cooldown' | 'blacklist' | 'quotaDepleted' | 'fatal' | 'authVerify';

export type QuotaAuthType = 'apikey' | 'oauth' | 'unknown';

export type QuotaAuthIssue =
  | {
      kind: 'google_account_verification';
      url?: string | null;
      message?: string | null;
    }
  | null;

export interface StaticQuotaConfig {
  priorityTier?: number | null;
  rateLimitPerMinute?: number | null;
  tokenLimitPerMinute?: number | null;
  totalTokenLimit?: number | null;
  authType?: QuotaAuthType | null;
  /**
   * Daily reset time for apikey quota exhaustion (HTTP 402).
   * Format:
   * - "HH:mm" => local time
   * - "HH:mmZ" => UTC time
   * If not set, defaults to 12:00 local.
   */
  apikeyDailyResetTime?: string | null;
}

export interface QuotaState {
  providerKey: string;
  inPool: boolean;
  reason: QuotaReason;
  authType: QuotaAuthType;
  authIssue?: QuotaAuthIssue;
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
  lastErrorCode: string | null;
  lastErrorAtMs: number | null;
  consecutiveErrorCount: number;
}

export type ErrorSeries = 'E429' | 'E5XX' | 'ENET' | 'EFATAL' | 'EOTHER';

export interface ErrorEventForQuota {
  providerKey: string;
  code?: string | null;
  message?: string | null;
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
const COOLDOWN_SCHEDULE_429_MS = [
  3_000,
  10_000,
  31_000,
  61_000
] as const;
const COOLDOWN_SCHEDULE_FATAL_MS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000
] as const;
const COOLDOWN_SCHEDULE_DEFAULT_MS = [
  3_000,
  10_000,
  31_000,
  61_000
] as const;
const ERROR_CHAIN_WINDOW_MS = 10 * 60_000;

const NETWORK_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UPSTREAM_HEADERS_TIMEOUT',
  'UPSTREAM_STREAM_TIMEOUT',
  'UPSTREAM_STREAM_IDLE_TIMEOUT',
  'UPSTREAM_STREAM_ABORTED'
] as const;

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
    authIssue: null,
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
    lastErrorCode: null,
    lastErrorAtMs: null,
    consecutiveErrorCount: 0
  };
}

export function normalizeErrorSeries(event: ErrorEventForQuota): ErrorSeries {
  if (event.fatal) {
    return 'EFATAL';
  }
  const status = typeof event.httpStatus === 'number' ? event.httpStatus : null;
  const rawCode = String(event.code || '').toUpperCase();
  const message = typeof event.message === 'string' ? event.message : '';
  const msgUpper = message.toUpperCase();

  if (status === 429 || rawCode.includes('429') || rawCode.includes('RATE') || rawCode.includes('QUOTA')) {
    return 'E429';
  }
  if (status && status >= 500) {
    return 'E5XX';
  }

  const networkMessageHints = [
    'FETCH FAILED',
    'NETWORK TIMEOUT',
    'SOCKET HANG UP',
    'CLIENT NETWORK SOCKET DISCONNECTED',
    'TLS HANDSHAKE TIMEOUT',
    'UNABLE TO VERIFY THE FIRST CERTIFICATE',
    'NETWORK ERROR',
    'TEMPORARILY UNREACHABLE'
  ] as const;

  if (
    rawCode.includes('TIMEOUT') ||
    NETWORK_ERROR_CODES.some((code) => rawCode.includes(code)) ||
    msgUpper.includes('TIMEOUT') ||
    networkMessageHints.some((hint) => msgUpper.includes(hint))
  ) {
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

function normalizeErrorKey(event: ErrorEventForQuota): string {
  const rawCode = String(event.code || '').trim().toUpperCase();
  if (rawCode) {
    return rawCode;
  }
  const status = typeof event.httpStatus === 'number' ? event.httpStatus : null;
  if (status && Number.isFinite(status)) {
    return `HTTP_${Math.floor(status)}`;
  }
  return 'ERR_UNKNOWN';
}

function computeCooldownMs(consecutive: number): number | null {
  return computeCooldownMsBySeries('EOTHER', consecutive);
}

function computeCooldownMsBySeries(series: ErrorSeries, consecutive: number): number | null {
  if (consecutive <= 0) {
    return null;
  }
  const schedule =
    series === 'E429'
      ? COOLDOWN_SCHEDULE_429_MS
      : series === 'EFATAL'
        ? COOLDOWN_SCHEDULE_FATAL_MS
        : COOLDOWN_SCHEDULE_DEFAULT_MS;
  const idx = Math.min(consecutive - 1, schedule.length - 1);
  return schedule[idx] ?? null;
}

export function applyErrorEvent(
  state: QuotaState,
  event: ErrorEventForQuota,
  nowMs: number = event.timestampMs ?? Date.now()
): QuotaState {
  // Manual/operator blacklist is rigid: automated error events must not override it.
  if (state.blacklistUntil !== null && nowMs < state.blacklistUntil) {
    return state;
  }

  const series = normalizeErrorSeries(event);
  const errorKey = normalizeErrorKey(event);

  const lastAt =
    typeof state.lastErrorAtMs === 'number' && Number.isFinite(state.lastErrorAtMs)
      ? state.lastErrorAtMs
      : null;
  const withinChainWindow =
    typeof lastAt === 'number' &&
    nowMs - lastAt >= 0 &&
    nowMs - lastAt <= ERROR_CHAIN_WINDOW_MS;
  const sameErrorKey = withinChainWindow && state.lastErrorCode === errorKey;
  const rawNextCount = sameErrorKey ? state.consecutiveErrorCount + 1 : 1;
  const schedule =
    series === 'E429'
      ? COOLDOWN_SCHEDULE_429_MS
      : series === 'EFATAL'
        ? COOLDOWN_SCHEDULE_FATAL_MS
        : COOLDOWN_SCHEDULE_DEFAULT_MS;
  // Never wrap cooldown back to the first step within the same error-chain window.
  // Wrapping causes repeated short retries (hammering) and makes cooldowns appear to "loop".
  const nextCount = Math.min(rawNextCount, schedule.length);
  const cooldownMs = computeCooldownMsBySeries(series, nextCount);
  const nextUntil = cooldownMs ? nowMs + cooldownMs : null;
  const existingUntil = typeof state.cooldownUntil === 'number' ? state.cooldownUntil : null;
  const cooldownUntil =
    typeof nextUntil === 'number' && Number.isFinite(nextUntil)
      ? typeof existingUntil === 'number' && existingUntil > nextUntil
        ? existingUntil
        : nextUntil
      : existingUntil;

  return {
    ...state,
    inPool: false,
    reason: 'cooldown',
    cooldownUntil,
    lastErrorSeries: series,
    lastErrorCode: errorKey,
    lastErrorAtMs: nowMs,
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
    ...(nextReason === 'ok' ? { authIssue: null } : {}),
    lastErrorSeries: null,
    lastErrorCode: null,
    lastErrorAtMs: null,
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
      authIssue: null,
      lastErrorSeries: null,
      lastErrorCode: null,
      lastErrorAtMs: null,
      consecutiveErrorCount: 0
    };
  } else if (next.cooldownUntil !== null && nowMs >= next.cooldownUntil) {
    next = {
      ...next,
      cooldownUntil: null,
      inPool: true,
      reason: next.reason === 'cooldown' || next.reason === 'quotaDepleted' ? 'ok' : next.reason,
      ...(next.reason === 'cooldown' || next.reason === 'quotaDepleted' ? { authIssue: null } : {})
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
