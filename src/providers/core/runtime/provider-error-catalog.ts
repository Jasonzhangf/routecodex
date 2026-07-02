export type ProviderErrorClass = 'unrecoverable' | 'recoverable' | 'route_runtime';

export type ProviderErrorCatalogEntry = {
  code: string; // numeric-ish canonical code e.g. 429.2000
  key: string; // symbolic key
  class: ProviderErrorClass;
  aliases: string[];
  status?: number;
  description: string;
};

const ENTRIES: ProviderErrorCatalogEntry[] = [
  // unrecoverable/auth-model
  { code: '401.1001', key: 'INVALID_API_KEY', class: 'unrecoverable', aliases: ['INVALID_API_KEY'], status: 401, description: 'Invalid API key' },
  { code: '401.1002', key: 'INVALID_ACCESS_TOKEN', class: 'unrecoverable', aliases: ['INVALID_ACCESS_TOKEN'], status: 401, description: 'Invalid access token' },
  { code: '403.1001', key: 'ACCESS_DENIED', class: 'unrecoverable', aliases: ['ACCESS_DENIED', 'FORBIDDEN'], status: 403, description: 'Access denied/forbidden' },
  { code: '429.2000', key: 'INSUFFICIENT_QUOTA', class: 'unrecoverable', aliases: ['INSUFFICIENT_QUOTA', 'QUOTA_DEPLETED'], status: 429, description: 'Account quota depleted' },
  { code: '403.1101', key: 'ACCOUNT_DISABLED', class: 'unrecoverable', aliases: ['ACCOUNT_DISABLED', 'ACCOUNT_SUSPENDED'], status: 403, description: 'Account disabled/suspended' },
  { code: '400.1201', key: 'MODEL_NOT_SUPPORTED', class: 'unrecoverable', aliases: ['MODEL_NOT_SUPPORTED', 'MODEL_DISABLED', 'NO_SUCH_MODEL'], status: 400, description: 'Model not supported/disabled/not found' },

  // recoverable/rate-limit/traffic
  { code: '429.1000', key: 'HTTP_429', class: 'recoverable', aliases: ['HTTP_429'], status: 429, description: 'Short lived rate limit' },
  { code: '429.2056', key: 'PROVIDER_STATUS_2056', class: 'recoverable', aliases: ['HTTP_429_2056', 'PROVIDER_STATUS_2056', 'provider_status_2056'], status: 429, description: 'Provider business quota/rate status 2056' },
  { code: '429.3000', key: 'PROVIDER_TRAFFIC_SATURATED', class: 'recoverable', aliases: ['PROVIDER_TRAFFIC_SATURATED'], status: 429, description: 'Provider saturated' },

  // recoverable/http upstream
  { code: '500.1000', key: 'HTTP_500', class: 'recoverable', aliases: ['HTTP_500'], status: 500, description: 'Internal upstream error' },
  { code: '502.1000', key: 'HTTP_502', class: 'recoverable', aliases: ['HTTP_502'], status: 502, description: 'Bad gateway' },
  { code: '503.1000', key: 'HTTP_503', class: 'recoverable', aliases: ['HTTP_503'], status: 503, description: 'Service unavailable' },
  { code: '504.1000', key: 'HTTP_504', class: 'recoverable', aliases: ['HTTP_504'], status: 504, description: 'Gateway timeout' },
  { code: '500.1999', key: 'HTTP_5XX', class: 'recoverable', aliases: ['HTTP_5XX'], description: 'Unknown upstream 5xx gateway/server error' },
  { code: '502.1200', key: 'UPSTREAM_EMPTY_OUTPUT', class: 'recoverable', aliases: ['UPSTREAM_EMPTY_OUTPUT'], status: 502, description: 'Upstream empty output' },

  // recoverable/sse-protocol
  { code: '502.7100', key: 'SSE_DECODE_ERROR', class: 'recoverable', aliases: ['SSE_DECODE_ERROR'], status: 502, description: 'SSE decode failed' },
  { code: '502.7300', key: 'SSE_TO_JSON_ERROR', class: 'recoverable', aliases: ['SSE_TO_JSON_ERROR'], status: 502, description: 'SSE to JSON failed' },
  { code: '502.7401', key: 'UPSTREAM_STREAM_TERMINATED', class: 'recoverable', aliases: ['UPSTREAM_STREAM_TERMINATED'], status: 502, description: 'Stream terminated before completion' },
  { code: '502.7402', key: 'UPSTREAM_STREAM_INCOMPLETE', class: 'recoverable', aliases: ['UPSTREAM_STREAM_INCOMPLETE'], status: 502, description: 'Stream incomplete' },
  { code: '504.7403', key: 'UPSTREAM_STREAM_TIMEOUT', class: 'recoverable', aliases: ['UPSTREAM_STREAM_TIMEOUT', 'UPSTREAM_HEADERS_TIMEOUT', 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT', 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'], status: 504, description: 'Upstream stream timeout family' },

  // local/network transport (non-http)
  { code: '0.1000', key: 'ECONNRESET', class: 'recoverable', aliases: ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'ECONNABORTED'], description: 'Network connection failure family' },
  { code: '0.2000', key: 'ETIMEDOUT', class: 'recoverable', aliases: ['ETIMEDOUT'], description: 'Network timeout' },
  { code: '0.3000', key: 'EPIPE', class: 'recoverable', aliases: ['EPIPE'], description: 'Broken pipe' },
  { code: '0.4000', key: 'EAI_AGAIN', class: 'recoverable', aliases: ['EAI_AGAIN'], description: 'DNS temporary failure' },
  { code: '0.6000', key: 'ERR_HTTP2_STREAM_CANCEL', class: 'recoverable', aliases: ['ERR_HTTP2_STREAM_CANCEL'], description: 'HTTP2 stream canceled' },

  // route runtime
  { code: '900.1001', key: 'PROVIDER_NOT_AVAILABLE', class: 'route_runtime', aliases: ['PROVIDER_NOT_AVAILABLE'], description: 'No available providers after routing instructions' },
];

const ALIAS_INDEX = new Map<string, ProviderErrorCatalogEntry>();
for (const e of ENTRIES) {
  for (const alias of e.aliases) {
    ALIAS_INDEX.set(alias.toUpperCase(), e);
  }
}

function readUpper(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim().toUpperCase() : undefined;
}

export function listKnownProviderErrorCatalog(): ProviderErrorCatalogEntry[] {
  return ENTRIES.slice();
}

export function normalizeKnownProviderError(input: {
  statusCode?: number;
  code?: unknown;
  upstreamCode?: unknown;
  message?: unknown;
}): ProviderErrorCatalogEntry | undefined {
  const status = typeof input.statusCode === 'number' ? input.statusCode : undefined;
  const code = readUpper(input.code);
  const upstream = readUpper(input.upstreamCode);
  const message = typeof input.message === 'string' ? input.message.toLowerCase() : '';

  if (
    status === 401
    && (
      message.includes('invalid token')
      || message.includes('invalid access token')
      || message.includes('access token is invalid')
    )
  ) {
    return ALIAS_INDEX.get('INVALID_ACCESS_TOKEN');
  }

  if (
    (status === 403 || status === 429)
    && (
      message.includes('insufficient_quota')
      || message.includes('quota exceeded')
      || message.includes('quota depleted')
      || message.includes('额度不足')
      || message.includes('订阅额度')
      || message.includes('余额')
    )
  ) {
    return ALIAS_INDEX.get('INSUFFICIENT_QUOTA');
  }

  if (status === 429 && (message.includes('daily') || message.includes('quota exceeded') || message.includes('daily_limit_exceeded'))) {
    return ALIAS_INDEX.get('INSUFFICIENT_QUOTA');
  }

  // Some providers (e.g. certain openai-compatible routers, deepseek-web relay) wrap
  // account-pool exhaustion as HTTP 400 with the message
  // "All available accounts exhausted". That is a quota-style condition, not a real
  // request validation error, so it must be normalised to the same quota class as
  // 429 INSUFFICIENT_QUOTA. Generic HTTP 400 does not belong to this catalog truth:
  // unknown/local contract 400s must stay undefined here and be classified by the
  // provider failure policy owner instead of being force-collapsed into a separate 400 bucket.
  if (
    status === 400
    && (
      message.includes('all available accounts exhausted')
      || message.includes('accounts exhausted')
      || message.includes('account pool exhausted')
      || message.includes('no available accounts')
      || message.includes('no available account')
    )
  ) {
    return ALIAS_INDEX.get('INSUFFICIENT_QUOTA');
  }

  if (code && ALIAS_INDEX.has(code)) return ALIAS_INDEX.get(code);
  if (upstream && ALIAS_INDEX.has(upstream)) return ALIAS_INDEX.get(upstream);

  if (status === 429) {
    return ALIAS_INDEX.get('HTTP_429');
  }
  if (status === 500) return ALIAS_INDEX.get('HTTP_500');
  if (status === 502) return ALIAS_INDEX.get('HTTP_502');
  if (status === 503) return ALIAS_INDEX.get('HTTP_503');
  if (status === 504) return ALIAS_INDEX.get('HTTP_504');
  if (typeof status === 'number' && status >= 500 && status <= 599) return ALIAS_INDEX.get('HTTP_5XX');

  if (message.includes('fetch failed') || message.includes('network error') || message.includes('socket hang up')) {
    return ALIAS_INDEX.get('ECONNRESET');
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return ALIAS_INDEX.get('ETIMEDOUT');
  }

  return undefined;
}

// SSOT: provider-agnostic 公共错误码冻结集合 (added 2026-06-05, /goal fallback-arch-audit Phase 2).
// 从 ENTRIES 自动聚合 (class === 'unrecoverable' | 'recoverable' 包含网络码 | recoverable 阻断子集)。
// provider-specific 错误码必须在各自 contract 暴露，**禁止**进入本 catalog。
export const PROVIDER_UNRECOVERABLE_CODES: ReadonlySet<string> = new Set<string>(
  ENTRIES.filter((e) => e.class === 'unrecoverable').flatMap((e) => e.aliases)
);

export const PROVIDER_NETWORK_CODES: ReadonlySet<string> = new Set<string>([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ERR_HTTP2_STREAM_CANCEL'
]);

export const PROVIDER_BLOCKING_RECOVERABLE_CODES: ReadonlySet<string> = new Set<string>(
  ENTRIES.filter((e) => e.class === 'recoverable' && (
    e.key === 'HTTP_429' ||
    e.key === 'HTTP_500' ||
    e.key === 'HTTP_502' ||
    e.key === 'HTTP_503' ||
    e.key === 'HTTP_504' ||
    e.key === 'HTTP_5XX' ||
    e.key === 'PROVIDER_TRAFFIC_SATURATED' ||
    e.key === 'SSE_DECODE_ERROR' ||
    e.key === 'SSE_TO_JSON_ERROR' ||
    e.key === 'UPSTREAM_EMPTY_OUTPUT'
  )).flatMap((e) => e.aliases)
);
