import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { RateLimitCooldownError } from './rate-limit-manager.js';
import {
  extractProviderFailureStatusCode,
  isProviderFailureNetworkTransportLike,
  resolveProviderFailureOutcome,
  type ProviderFailureClassification,
  type ProviderFailureRateLimitKind
} from './provider-failure-policy.js';

export type ProviderErrorClassification = {
  error: ProviderErrorAugmented;
  message: string;
  statusCode?: number;
  upstreamCode?: string;
  upstreamMessage?: string;
  classification?: ProviderFailureClassification;
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

export function classifyProviderError(options: ProviderErrorClassifierOptions): ProviderErrorClassification {
  const err: ProviderErrorAugmented =
    (options.error instanceof Error ? options.error : new Error(String(options.error))) as ProviderErrorAugmented;
  const message = typeof err.message === 'string' ? err.message : String(options.error ?? 'unknown error');
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

  const isRateLimit = statusText.includes('429') || msgLower.includes('429');
  const isDailyLimit429 = isRateLimit && options.detectDailyLimit(msgLower, upstreamMessageLower);
  const isSyntheticCooldown = err instanceof RateLimitCooldownError;
  let rateLimitKind: ProviderFailureRateLimitKind | undefined;
  let forceFatalRateLimit = false;

  if (isRateLimit) {
    // 当前收口模型里，429 不再分裂成 synthetic/daily/special cooldown 语义。
    // 只保留：
    // - 日额度类 429：记为不可恢复 provider 错误
    // - 其他 429：记为可恢复 provider 错误
    if (isSyntheticCooldown) {
      rateLimitKind = 'short_lived';
      forceFatalRateLimit = false;
    } else if (isDailyLimit429) {
      options.forceRateLimitFailure(options.context.providerKey, options.context.model);
      rateLimitKind = undefined;
      forceFatalRateLimit = true;
    } else {
      options.registerRateLimitFailure(options.context.providerKey, options.context.model);
      rateLimitKind = 'short_lived';
      forceFatalRateLimit = false;
    }
  }
  const outcome = resolveProviderFailureOutcome({
    error: err,
    stage: 'provider.http',
    statusCode,
    errorCode: typeof err.code === 'string' ? err.code : undefined,
    upstreamCode: typeof upstreamCode === 'string' ? upstreamCode : undefined,
    reason: message,
    classification: isDailyLimit429 ? 'unrecoverable' : undefined,
    rateLimitKind
  });
  return {
    error: err,
    message,
    statusCode,
    upstreamCode,
    upstreamMessage,
    classification: outcome.classification,
    recoverable: outcome.recoverable,
    affectsHealth: outcome.affectsHealth,
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
