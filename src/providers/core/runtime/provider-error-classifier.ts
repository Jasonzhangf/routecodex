import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { RateLimitCooldownError } from './rate-limit-manager.js';
import {
  extractProviderFailureStatusCode,
  isProviderFailureClientDisconnect,
  isProviderFailureHealthNeutral,
  isProviderFailureNetworkTransportLike,
  normalizeProviderFailureCodeKey,
  resolveProviderFailureClassification
} from './provider-failure-policy.js';

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

function isClientDisconnectAbortError(error: ProviderErrorAugmented, msgLower: string): boolean {
  return isProviderFailureClientDisconnect(error)
    || (
      error.name === 'AbortError'
      && (
        msgLower.includes('client_request_aborted')
        || msgLower.includes('client_response_closed')
        || msgLower.includes('client_timeout_hint_expired')
      )
    );
}

export function classifyProviderError(options: ProviderErrorClassifierOptions): ProviderErrorClassification {
  const err: ProviderErrorAugmented =
    (options.error instanceof Error ? options.error : new Error(String(options.error))) as ProviderErrorAugmented;
  const message = typeof err.message === 'string' ? err.message : String(options.error ?? 'unknown error');
  const codeUpper = normalizeProviderFailureCodeKey(err.code) ?? '';
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

  const statusText = String(statusCode ?? '');
  const msgLower = message.toLowerCase();
  const isClientDisconnect = isClientDisconnectAbortError(err, msgLower);
  const isAbortError = err.name === 'AbortError' || msgLower.includes('operation was aborted');
  const isNetworkError = !statusCode && !isClientDisconnect && (looksLikeNetworkTransportError(err, msgLower) || isAbortError);

  const isRateLimit = statusText.includes('429') || msgLower.includes('429');
  const isDailyLimit429 = isRateLimit && options.detectDailyLimit(msgLower, upstreamMessageLower);
  const isSyntheticCooldown = err instanceof RateLimitCooldownError;
  const isSseToJsonError = codeUpper === 'SSE_TO_JSON_ERROR' || msgLower.includes('sse_to_json_error');
  const classification = resolveProviderFailureClassification({
    error: err,
    stage: 'provider.http',
    statusCode,
    errorCode: typeof err.code === 'string' ? err.code : undefined,
    upstreamCode: typeof upstreamCode === 'string' ? upstreamCode : undefined,
    reason: message
  });
  let recoverable = classification === 'recoverable';
  let affectsHealth = !isProviderFailureHealthNeutral({
    stage: 'provider.http',
    error: err,
    errorCode: typeof err.code === 'string' ? err.code : undefined,
    upstreamCode: typeof upstreamCode === 'string' ? upstreamCode : undefined,
    statusCode,
    classification
  });
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
      // 短期 429：记账但不再毒化 provider health；实际 backoff/reroute 由统一 failure policy 决定。
      options.registerRateLimitFailure(options.context.providerKey, options.context.model);
      recoverable = true;
      affectsHealth = false;
      forceFatalRateLimit = false;
    }
  }
  if (isClientDisconnect) {
    recoverable = false;
    affectsHealth = false;
  }
  if (isAbortError && !isClientDisconnect) {
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
  return extractProviderFailureStatusCode(error);
}

export function looksLikeNetworkTransportError(error: ProviderErrorAugmented, msgLower: string): boolean {
  return isProviderFailureNetworkTransportLike(error) || msgLower.includes('network error');
}
