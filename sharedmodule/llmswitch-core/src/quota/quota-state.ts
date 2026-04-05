import type { ErrorEventForQuota, ErrorSeries, QuotaAuthType, QuotaReason, QuotaState, StaticQuotaConfig, SuccessEventForQuota } from './types.js';

const COOLDOWN_SCHEDULE_429_MS = [3_000, 10_000, 31_000, 61_000] as const;
const COOLDOWN_SCHEDULE_FATAL_MS = [3_000, 10_000, 31_000, 61_000] as const;
const COOLDOWN_SCHEDULE_DEFAULT_MS = [3_000, 10_000, 31_000, 61_000] as const;
const COOLDOWN_SCHEDULE_TRANSIENT_KEEP_POOL_MS = [3_000, 5_000, 10_000, 31_000] as const;
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

  if (status === 429 || rawCode.includes('429') || rawCode.includes('RATE') || rawCode.includes('QUOTA')) {
    return 'E429';
  }
  if (status && status >= 500) {
    return 'E5XX';
  }
  if (rawCode.includes('TIMEOUT') || NETWORK_ERROR_CODES.some((code) => rawCode.includes(code))) {
    return 'ENET';
  }
  if (rawCode.includes('AUTH') || rawCode.includes('UNAUTHORIZED') || rawCode.includes('CONFIG') || rawCode.includes('FATAL')) {
    return 'EFATAL';
  }
  return 'EOTHER';
}

function normalizeErrorKey(event: ErrorEventForQuota): string {
  const rawCode = String(event.code || '').trim().toUpperCase();
  const status = typeof event.httpStatus === 'number' ? event.httpStatus : null;
  const isGenericCode =
    rawCode === '' ||
    rawCode === 'ERR_PROVIDER_FAILURE' ||
    rawCode === 'ERR_PIPELINE_FAILURE' ||
    rawCode === 'ERR_COMPATIBILITY' ||
    rawCode === 'EXTERNAL_ERROR' ||
    rawCode === 'INTERNAL_ERROR' ||
    rawCode === 'TOOL_ERROR';
  if (!isGenericCode) {
    return rawCode;
  }
  if (status && Number.isFinite(status)) {
    return `HTTP_${Math.floor(status)}`;
  }
  return rawCode || 'ERR_UNKNOWN';
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

function shouldKeepProviderInPoolDuringCooldown(series: ErrorSeries, consecutive: number): boolean {
  if (consecutive <= 0) {
    return false;
  }
  return (series === 'ENET' || series === 'E5XX' || series === 'EOTHER') && consecutive <= 2;
}

function computeTransientKeepPoolCooldownMs(series: ErrorSeries, consecutive: number): number | null {
  if (!shouldKeepProviderInPoolDuringCooldown(series, consecutive)) {
    return null;
  }
  const idx = Math.min(consecutive - 1, COOLDOWN_SCHEDULE_TRANSIENT_KEEP_POOL_MS.length - 1);
  return COOLDOWN_SCHEDULE_TRANSIENT_KEEP_POOL_MS[idx] ?? null;
}

export function tickQuotaStateTime(state: QuotaState, nowMs: number): QuotaState {
  let next: QuotaState = state;
  if (typeof next.cooldownUntil === 'number' && next.cooldownUntil <= nowMs) {
    next = { ...next, cooldownUntil: null, cooldownKeepsPool: undefined };
  }
  if (typeof next.blacklistUntil === 'number' && next.blacklistUntil <= nowMs) {
    next = { ...next, blacklistUntil: null };
  }
  if (next.authIssue) {
    if (next.inPool !== false || next.reason !== 'authVerify') {
      next = { ...next, inPool: false, reason: 'authVerify' };
    }
    return next;
  }
  const inCooldown = typeof next.cooldownUntil === 'number' && next.cooldownUntil > nowMs;
  const inBlacklist = typeof next.blacklistUntil === 'number' && next.blacklistUntil > nowMs;
  if (inBlacklist) {
    if (next.inPool !== false || next.reason !== 'blacklist') {
      next = { ...next, inPool: false, reason: 'blacklist' };
    }
    return next;
  }
  if (inCooldown) {
    const keepInPool = next.cooldownKeepsPool === true;
    if (next.inPool !== keepInPool || next.reason !== 'cooldown') {
      next = { ...next, inPool: keepInPool, reason: 'cooldown' };
    }
    return next;
  }
  // TTLs expired: only auto-reset "cooldown/blacklist" back to ok.
  if (next.reason === 'cooldown' || next.reason === 'blacklist') {
    next = { ...next, inPool: true, reason: 'ok', cooldownKeepsPool: undefined };
  }
  return next;
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
  const schedule =
    series === 'E429'
      ? COOLDOWN_SCHEDULE_429_MS
      : series === 'EFATAL'
        ? COOLDOWN_SCHEDULE_FATAL_MS
        : COOLDOWN_SCHEDULE_DEFAULT_MS;
  const rawNextCount = sameErrorKey ? state.consecutiveErrorCount + 1 : 1;
  const nextCount = Math.min(rawNextCount, Math.max(1, schedule.length));
  const cooldownMs =
    computeTransientKeepPoolCooldownMs(series, nextCount) ?? computeCooldownMsBySeries(series, nextCount);
  const nextUntil = cooldownMs ? nowMs + cooldownMs : null;
  const existingUntil = sameErrorKey && typeof state.cooldownUntil === 'number' ? state.cooldownUntil : null;
  const cooldownUntil =
    typeof nextUntil === 'number' && Number.isFinite(nextUntil)
      ? typeof existingUntil === 'number' && existingUntil > nextUntil
        ? existingUntil
        : nextUntil
      : existingUntil;

  const inCooldown = typeof cooldownUntil === 'number' && cooldownUntil > nowMs;
  const inBlacklist = typeof state.blacklistUntil === 'number' && state.blacklistUntil > nowMs;
  const cooldownKeepsPool = shouldKeepProviderInPoolDuringCooldown(series, nextCount);
  const inPool = !inBlacklist && (!inCooldown || cooldownKeepsPool);

  return {
    ...state,
    inPool,
    reason: inBlacklist ? 'blacklist' : inCooldown ? 'cooldown' : 'ok',
    cooldownUntil,
    cooldownKeepsPool: inCooldown ? cooldownKeepsPool : undefined,
    lastErrorSeries: series,
    lastErrorCode: errorKey,
    lastErrorAtMs: nowMs,
    consecutiveErrorCount: nextCount,
    ...(event.authIssue ? { authIssue: event.authIssue, reason: 'authVerify', inPool: false } : {})
  };
}

export function applySuccessEvent(
  state: QuotaState,
  _event: SuccessEventForQuota,
  nowMs: number = _event.timestampMs ?? Date.now()
): QuotaState {
  const next: QuotaState = {
    ...state,
    lastErrorSeries: null,
    lastErrorCode: null,
    lastErrorAtMs: null,
    consecutiveErrorCount: 0
  };
  return tickQuotaStateTime(next, nowMs);
}
