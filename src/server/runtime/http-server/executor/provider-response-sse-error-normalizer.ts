import { asRecord } from '../provider-utils.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import {
  isContextLengthExceededError,
  isRetryableNetworkSseWrapperError
} from './provider-response-shared-pure-blocks.js';

export function isEmptyOpenAiChatSseBridgeError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized.includes('openai chat sse response did not contain json data events')
    || normalized.includes('provider sse marker did not include materializable stream or bodytext');
}

export function isEmptyAnthropicSseBridgeError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized.includes('anthropic sse response did not contain materializable content blocks');
}

export function remapBridgeSseErrorToHttp(error: Record<string, unknown>, message: string): boolean {
  const detailRecord = asRecord(error.details);
  const upstreamCode =
    typeof error.upstreamCode === 'string'
      ? error.upstreamCode
      : typeof detailRecord?.upstreamCode === 'string'
        ? detailRecord.upstreamCode
        : undefined;
  const detailReason = typeof detailRecord?.reason === 'string' ? detailRecord.reason : undefined;
  const statusCodeRaw =
    typeof error.statusCode === 'number'
      ? error.statusCode
      : typeof error.status === 'number'
        ? error.status
        : typeof detailRecord?.statusCode === 'number'
          ? detailRecord.statusCode
          : undefined;
  const isContextLengthExceeded = isContextLengthExceededError(message, upstreamCode, detailReason);
  if (isContextLengthExceeded) {
    error.status = 400;
    error.statusCode = 400;
    error.retryable = false;
    error.code = 'CONTEXT_LENGTH_EXCEEDED';
    if (typeof error.upstreamCode !== 'string' || !String(error.upstreamCode).trim()) {
      error.upstreamCode = upstreamCode || 'context_length_exceeded';
    }
    return true;
  }
  if (isRateLimitLikeError(message, String(error.code || ''), upstreamCode)) {
    error.status = 429;
    error.statusCode = 429;
    error.retryable = true;
    error.code = 'HTTP_429';
    return true;
  }
  if (isRetryableNetworkSseWrapperError(message, upstreamCode, statusCodeRaw)) {
    error.status = 502;
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'HTTP_502';
    return true;
  }
  if (isEmptyOpenAiChatSseBridgeError(message)) {
    error.status = 502;
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'SSE_DECODE_ERROR';
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return true;
  }
  if (isEmptyAnthropicSseBridgeError(message)) {
    error.status = 502;
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'SSE_DECODE_ERROR';
    error.requestExecutorProviderErrorStage = 'provider.sse_decode';
    return true;
  }
  return false;
}
