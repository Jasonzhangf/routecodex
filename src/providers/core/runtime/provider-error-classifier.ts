import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';

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
  const isAbortError = err.name === 'AbortError' || msgLower.includes('operation was aborted');
  const isNetworkError = !statusCode && (looksLikeNetworkTransportError(err, msgLower) || isAbortError);
  const usesOauth = options.authMode === 'oauth';

  const isRateLimit = statusText.includes('429') || msgLower.includes('429');
  const isDailyLimit429 = isRateLimit && options.detectDailyLimit(msgLower, upstreamMessageLower);

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

  const isGenericClientError = isClient4xx && !is401 && !is402 && !isRateLimit;

  let recoverable = isRateLimit || isClient400 || isGenericClientError;
  if (isNetworkError) {
    recoverable = true;
  }
  if (is401 || is402 || is500 || is524) {
    recoverable = false;
  }

  let affectsHealth = !recoverable;
  let forceFatalRateLimit = false;

  if (isRateLimit) {
    if (isDailyLimit429) {
      options.forceRateLimitFailure(options.context.providerKey, options.context.model);
    }
    const escalated = options.registerRateLimitFailure(options.context.providerKey, options.context.model);
    affectsHealth = escalated;
    if (escalated) {
      recoverable = false;
      forceFatalRateLimit = true;
    } else {
      recoverable = true;
      affectsHealth = false;
    }
    if (isDailyLimit429) {
      affectsHealth = true;
      recoverable = false;
      forceFatalRateLimit = true;
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
  const directStatus = typeof response?.status === 'number' ? response.status : undefined;
  const directStatusCode = typeof (response as { statusCode?: number })?.statusCode === 'number'
    ? (response as { statusCode?: number }).statusCode
    : undefined;
  const nestedStatus =
    response &&
    typeof response === 'object' &&
    typeof (response as { data?: Record<string, unknown> })?.data?.status === 'number'
      ? ((response as { data?: Record<string, unknown> }).data!.status as number)
      : undefined;
  const nestedErrorStatus =
    response &&
    typeof response === 'object' &&
    typeof (response as { data?: { error?: { status?: number } } })?.data?.error?.status === 'number'
      ? ((response as { data?: { error?: { status?: number } } }).data!.error!.status as number)
      : undefined;
  return [directStatus, directStatusCode, nestedStatus, nestedErrorStatus].find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  );
}
