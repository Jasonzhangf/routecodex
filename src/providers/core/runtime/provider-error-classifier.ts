import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { RateLimitCooldownError } from './rate-limit-manager.js';

export type ProviderErrorClassification = {
  error: ProviderErrorAugmented;
  message: string;
  statusCode?: number;
  upstreamCode?: string;
  upstreamMessage?: string;
  recoverable: boolean;
  affectsHealth: boolean;
  forceFatalRateLimit: boolean;
  isRateLimit: boolean;
  isDailyLimitRateLimit: boolean;
};

export type ProviderErrorClassifierOptions = {
  error: unknown;
  context: ProviderContext;
  detectDailyLimit(messageLower: string, upstreamLower?: string): boolean;
  registerRateLimitFailure(providerKey?: string, model?: string): boolean;
  forceRateLimitFailure(providerKey?: string, model?: string): void;
  authMode?: 'apikey' | 'oauth';
};

const NETWORK_ERROR_CODE_SET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED'
]);

export function classifyProviderError(options: ProviderErrorClassifierOptions): ProviderErrorClassification {
  const err: ProviderErrorAugmented =
    (options.error instanceof Error ? options.error : new Error(String(options.error))) as ProviderErrorAugmented;
  const message = typeof err.message === 'string' ? err.message : String(options.error ?? 'unknown error');
  const codeUpper = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  let statusCode = extractStatusCodeFromError(err);
  if (!statusCode) {
    const match = message.match(/HTTP\s+(\d{3})/i);
    if (match) {
      statusCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(statusCode)) {
        err.statusCode = statusCode;
      }
    }
  }
  const upstream = err.response?.data;
  const upstreamCode = err.code || upstream?.error?.code;
  const upstreamMessage = upstream?.error?.message;
  const upstreamMessageLower = typeof upstreamMessage === 'string' ? upstreamMessage.toLowerCase() : '';
  const upstreamCodeLower = typeof upstreamCode === 'string' ? upstreamCode.toLowerCase() : '';

  const statusText = String(statusCode ?? '');
  const msgLower = message.toLowerCase();
  const isAbortError = err.name === 'AbortError' || msgLower.includes('operation was aborted');
  const isNetworkError = !statusCode && (looksLikeNetworkTransportError(err, msgLower) || isAbortError);
  const usesOauth = options.authMode === 'oauth';

  const isRateLimit = statusText.includes('429') || msgLower.includes('429');
  const isDailyLimit429 = isRateLimit && options.detectDailyLimit(msgLower, upstreamMessageLower);
  const isSyntheticCooldown = err instanceof RateLimitCooldownError;
  const isSseToJsonError = codeUpper === 'SSE_TO_JSON_ERROR' || msgLower.includes('sse_to_json_error');

  const statusCodeValue = typeof statusCode === 'number' ? statusCode : undefined;
  const isClient4xx =
    typeof statusCodeValue === 'number'
      ? statusCodeValue >= 400 && statusCodeValue < 500
      : statusText.startsWith('4');
  const isClient400 = statusText.includes('400') || msgLower.includes('400');
  const is401 = statusText.includes('401') || msgLower.includes('401');
  const is402 = statusText.includes('402') || msgLower.includes('402');
  const is500 = statusText.includes('500') || msgLower.includes('500');
  const is524 = statusText.includes('524') || msgLower.includes('524');
  const isIflowAkBlocked =
    statusCodeValue === 434 ||
    upstreamCodeLower === '434' ||
    msgLower.includes('access to the current ak has been blocked due to unauthorized requests') ||
    upstreamMessageLower.includes('access to the current ak has been blocked due to unauthorized requests');

  const isGenericClientError = isClient4xx && !is401 && !is402 && !isRateLimit;

  let recoverable = isRateLimit || isClient400 || isGenericClientError;
  let affectsHealth = !recoverable;
  if (isNetworkError) {
    recoverable = true;
    affectsHealth = false;
  }
  if (is401 || is402 || is500 || is524) {
    recoverable = false;
    affectsHealth = !recoverable;
  }
  let forceFatalRateLimit = false;

  if (isRateLimit) {
    // 对 429 进行细分处理：
    // - 人为构造的 RateLimitCooldownError：表示 Provider 层已经根据冷却窗口主动拦截请求，
    //   这类错误只用于触发虚拟路由重选，不应该进入「多次 429 → 熔断」逻辑。
    // - 日额度耗尽类 429（detectDailyLimit=true）：属于硬性限流，直接标记为不可恢复并影响健康。
    // - 其他短期 429：始终视为可恢复错误，允许 Virtual Router 根据健康状态与冷却信息做降级与重试。
    if (isSyntheticCooldown) {
      recoverable = true;
      affectsHealth = false;
      forceFatalRateLimit = false;
    } else if (isDailyLimit429) {
      options.forceRateLimitFailure(options.context.providerKey, options.context.model);
      affectsHealth = true;
      recoverable = false;
      forceFatalRateLimit = true;
    } else {
      // 短期 429：始终视为影响健康的可恢复错误，交由 VirtualRouter 立即执行冷却/切换。
      // registerRateLimitFailure 仅用于计数与日志，不再控制 affectsHealth / fatal 行为。
      options.registerRateLimitFailure(options.context.providerKey, options.context.model);
      recoverable = true;
      affectsHealth = true;
      forceFatalRateLimit = false;
    }
  }
  if (is401 && usesOauth) {
    recoverable = true;
    affectsHealth = false;
  }
  if (isAbortError) {
    recoverable = true;
    affectsHealth = false;
  }
  // Internal conversion errors (client-side) must not poison provider health.
  // Example: SSE_TO_JSON_ERROR can be triggered by downstream stream termination or
  // converter state, and does not imply the upstream/provider is unhealthy.
  if (isSseToJsonError) {
    recoverable = true;
    affectsHealth = false;
    forceFatalRateLimit = false;
  }
  if (isIflowAkBlocked) {
    // iFlow 434 = account-level block; never retry automatically.
    recoverable = false;
    affectsHealth = true;
    forceFatalRateLimit = false;
  }

  return {
    error: err,
    message,
    statusCode,
    upstreamCode,
    upstreamMessage,
    recoverable,
    affectsHealth,
    forceFatalRateLimit,
    isRateLimit,
    isDailyLimitRateLimit: isDailyLimit429
  };
}

export function extractStatusCodeFromError(error: ProviderErrorAugmented): number | undefined {
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (typeof error.status === 'number') {
    return error.status;
  }
  const responseStatus = readStatusCodeFromResponse(error);
  if (typeof responseStatus === 'number') {
    return responseStatus;
  }
  if (typeof error.message === 'string') {
    const match = error.message.match(/HTTP\s+(\d{3})/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

export function looksLikeNetworkTransportError(error: ProviderErrorAugmented, msgLower: string): boolean {
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code && NETWORK_ERROR_CODE_SET.has(code)) {
    return true;
  }
  const hints = [
    'fetch failed',
    'network timeout',
    'socket hang up',
    'client network socket disconnected',
    'tls handshake timeout',
    'unable to verify the first certificate',
    'network error',
    'temporarily unreachable'
  ];
  return hints.some((hint) => msgLower.includes(hint));
}

function readStatusCodeFromResponse(error: ProviderErrorAugmented): number | undefined {
  const response = error?.response as Record<string, unknown> | undefined;
  const directStatus = parseStatusCandidate(response?.status);
  const directStatusCode = parseStatusCandidate((response as { statusCode?: unknown })?.statusCode);
  const nestedStatus = parseStatusCandidate((response as { data?: Record<string, unknown> })?.data?.status);
  const nestedErrorStatus = parseStatusCandidate(
    (response as { data?: { error?: { status?: unknown } } })?.data?.error?.status
  );
  const nestedUpstreamStatus = parseStatusCandidate(
    (response as { data?: { upstream?: { status?: unknown } } })?.data?.upstream?.status
  );
  return [nestedUpstreamStatus, nestedErrorStatus, nestedStatus, directStatus, directStatusCode].find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  );
}

function parseStatusCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
