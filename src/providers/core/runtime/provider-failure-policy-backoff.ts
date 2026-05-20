import type { ProviderFailureBackoffPlan, ProviderFailureBackoffScope } from './provider-failure-policy.js';
import {
  isProviderFailureNetworkTransportLike,
  extractProviderFailureStatusCode,
  normalizeProviderFailureCodeKey
} from './provider-failure-policy-impl.js';

export function resolveProviderFailureBackoffPlanBlock(args: {
  scope: ProviderFailureBackoffScope;
  error?: unknown;
  statusCode?: number;
}): ProviderFailureBackoffPlan {
  const scope = args.scope;
  if (scope === 'none') {
    return {
      scope,
      keyKind: scope,
      baseMs: 0,
      maxMs: 0
    };
  }
  return {
    scope,
    keyKind: scope,
    baseMs: resolveProviderFailureBackoffBaseMs({
      scope,
      error: args.error,
      statusCode: args.statusCode
    }),
    maxMs: resolveProviderFailureBackoffMaxMs({
      scope,
      error: args.error,
      statusCode: args.statusCode
    })
  };
}

export function computeProviderFailureBackoffDelayMsBlock(args: {
  scope: Exclude<ProviderFailureBackoffScope, 'none'>;
  error?: unknown;
  statusCode?: number;
  attempt?: number;
  consecutive?: number;
}): number {
  const plan = resolveProviderFailureBackoffPlanBlock({
    scope: args.scope,
    error: args.error,
    statusCode: args.statusCode
  });
  const stepRaw =
    typeof args.consecutive === 'number' && Number.isFinite(args.consecutive)
      ? args.consecutive
      : args.attempt;
  const step = Math.max(1, Math.floor(typeof stepRaw === 'number' && Number.isFinite(stepRaw) ? stepRaw : 1));
  const exponentialMs = Math.min(plan.maxMs, plan.baseMs * Math.pow(2, Math.max(0, step - 1)));
  const retryAfterMs = readRetryAfterHeaderMs(args.error, args.statusCode, plan.maxMs);
  return Math.max(exponentialMs, retryAfterMs);
}

function resolveProviderFailureBackoffBaseMs(args: {
  scope: Exclude<ProviderFailureBackoffScope, 'none'>;
  error?: unknown;
  statusCode?: number;
}): number {
  const status = typeof args.statusCode === 'number' ? args.statusCode : extractProviderFailureStatusCode(args.error);
  const providerErrorCode = normalizeProviderFailureCodeKey(
    args.error && typeof args.error === 'object'
      ? (args.error as { code?: unknown }).code
      : undefined
  );
  const providerUpstreamCode = normalizeProviderFailureCodeKey(
    args.error && typeof args.error === 'object'
      ? (args.error as { upstreamCode?: unknown }).upstreamCode
      : undefined
  );
  const isWindsurfStreamCanceled =
    providerErrorCode === 'ERR_HTTP2_STREAM_CANCEL'
    || providerUpstreamCode === 'ERR_HTTP2_STREAM_CANCEL';
  if (args.scope === 'recoverable') {
    if (status === 429) {
      return readPositiveIntFromEnv([
        'ROUTECODEX_429_BACKOFF_BASE_MS',
        'RCC_429_BACKOFF_BASE_MS'
      ], process.env.NODE_ENV === 'test' ? 200 : 1_000);
    }
    return readPositiveIntFromEnv([
      'ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS',
      'RCC_RECOVERABLE_BACKOFF_BASE_MS'
    ], process.env.NODE_ENV === 'test' ? 200 : 1_000);
  }
  if (status === 429) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_429_BACKOFF_BASE_MS',
      'RCC_429_BACKOFF_BASE_MS'
    ], process.env.NODE_ENV === 'test' ? 200 : 1_000);
  }
  if (isWindsurfStreamCanceled) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_WINDSURF_STREAM_CANCEL_BACKOFF_BASE_MS',
      'RCC_WINDSURF_STREAM_CANCEL_BACKOFF_BASE_MS'
    ], process.env.NODE_ENV === 'test' ? 1_000 : 3_000);
  }
  if (isProviderFailureNetworkTransportLike(args.error)) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_NETWORK_RETRY_BACKOFF_BASE_MS',
      'RCC_NETWORK_RETRY_BACKOFF_BASE_MS'
    ], 500);
  }
  return readPositiveIntFromEnv([
    'ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS',
    'RCC_PROVIDER_RETRY_BACKOFF_BASE_MS'
  ], process.env.NODE_ENV === 'test' ? 800 : 2_000);
}

function resolveProviderFailureBackoffMaxMs(args: {
  scope: Exclude<ProviderFailureBackoffScope, 'none'>;
  error?: unknown;
  statusCode?: number;
}): number {
  const status = typeof args.statusCode === 'number' ? args.statusCode : extractProviderFailureStatusCode(args.error);
  const providerErrorCode = normalizeProviderFailureCodeKey(
    args.error && typeof args.error === 'object'
      ? (args.error as { code?: unknown }).code
      : undefined
  );
  const providerUpstreamCode = normalizeProviderFailureCodeKey(
    args.error && typeof args.error === 'object'
      ? (args.error as { upstreamCode?: unknown }).upstreamCode
      : undefined
  );
  const isWindsurfStreamCanceled =
    providerErrorCode === 'ERR_HTTP2_STREAM_CANCEL'
    || providerUpstreamCode === 'ERR_HTTP2_STREAM_CANCEL';
  if (args.scope === 'recoverable') {
    if (status === 429) {
      return readPositiveIntFromEnv([
        'ROUTECODEX_429_BACKOFF_MAX_MS',
        'RCC_429_BACKOFF_MAX_MS'
      ], process.env.NODE_ENV === 'test' ? 800 : 4_000);
    }
    return readPositiveIntFromEnv([
      'ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS',
      'RCC_RECOVERABLE_BACKOFF_MAX_MS'
    ], process.env.NODE_ENV === 'test' ? 5_000 : 120_000);
  }
  if (status === 429) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_429_BACKOFF_MAX_MS',
      'RCC_429_BACKOFF_MAX_MS'
    ], process.env.NODE_ENV === 'test' ? 800 : 30_000);
  }
  if (isWindsurfStreamCanceled) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_WINDSURF_STREAM_CANCEL_BACKOFF_MAX_MS',
      'RCC_WINDSURF_STREAM_CANCEL_BACKOFF_MAX_MS'
    ], process.env.NODE_ENV === 'test' ? 8_000 : 30_000);
  }
  if (isProviderFailureNetworkTransportLike(args.error)) {
    return readPositiveIntFromEnv([
      'ROUTECODEX_NETWORK_RETRY_BACKOFF_MAX_MS',
      'RCC_NETWORK_RETRY_BACKOFF_MAX_MS'
    ], 12_000);
  }
  return readPositiveIntFromEnv([
    'ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS',
    'RCC_PROVIDER_RETRY_BACKOFF_MAX_MS'
  ], process.env.NODE_ENV === 'test' ? 15_000 : 60_000);
}

function readPositiveIntFromEnv(keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = process.env[key];
    const parsed = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function readRetryAfterHeaderMs(error: unknown, statusCode: number | undefined, maxMs: number): number {
  if (statusCode !== 429 || !error || typeof error !== 'object') {
    return 0;
  }
  const record = error as {
    response?: { headers?: Record<string, unknown> };
    details?: { response?: { headers?: Record<string, unknown> } };
  };
  const headers =
    (record.response && typeof record.response === 'object' && record.response.headers && typeof record.response.headers === 'object'
      ? record.response.headers
      : undefined)
    ?? (record.details
      && typeof record.details === 'object'
      && record.details.response
      && typeof record.details.response === 'object'
      && record.details.response.headers
      && typeof record.details.response.headers === 'object'
      ? record.details.response.headers
      : undefined);
  if (!headers) {
    return 0;
  }
  const retryAfterRaw =
    headers['retry-after']
    ?? headers['Retry-After']
    ?? headers['retry_after']
    ?? headers['Retry_After'];
  if (typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) && retryAfterRaw > 0) {
    return Math.min(maxMs, Math.round(retryAfterRaw * 1000));
  }
  if (typeof retryAfterRaw === 'string') {
    const trimmed = retryAfterRaw.trim();
    const asSeconds = Number.parseFloat(trimmed);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      return Math.min(maxMs, Math.round(asSeconds * 1000));
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
      const deltaMs = parsedDate - Date.now();
      if (deltaMs > 0) {
        return Math.min(maxMs, deltaMs);
      }
    }
  }
  return 0;
}
