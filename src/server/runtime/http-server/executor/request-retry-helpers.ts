import { extractStatusCodeFromError } from './utils.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';
import { isRateLimitLikeErrorNative } from '../../../../modules/llmswitch/bridge/error-execution-decision-host.js';

export {
  extractStatusCodeFromError
};

export function isRateLimitLikeError(message: string, ...codes: Array<string | undefined>): boolean {
  return isRateLimitLikeErrorNative(message, ...codes);
}

export function isSseDecodeRateLimitError(error: unknown, status: number | undefined): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const upstreamCode = typeof record.upstreamCode === 'string' ? record.upstreamCode : '';
  const known = normalizeKnownProviderError({ statusCode: status, code, upstreamCode, message });
  if (known?.code === '429.1000' || known?.code === '429.2056' || known?.code === '429.3000') {
    return true;
  }
  if (known?.code === '429.2000') {
    return false;
  }
  if (status !== 429) {
    return false;
  }
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const sseLike =
    code === 'SSE_DECODE_ERROR' ||
    name === 'providerprotocolerror' ||
    message.toLowerCase().includes('sse');
  return sseLike && isRateLimitLikeError(message, code, upstreamCode);
}

export function isSseDecodeRetryableNetworkError(error: unknown, status: number | undefined): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const upstreamCode = typeof record.upstreamCode === 'string' ? record.upstreamCode.toLowerCase() : '';
  const known = normalizeKnownProviderError({ statusCode: status, code, upstreamCode, message });
  if (known?.code === '0.1000' || known?.code === '0.2000' || known?.code === '0.3000' || known?.code === '0.4000' || known?.code === '0.6000') {
    return true;
  }
  if (status !== 502) {
    return false;
  }
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const sseLike =
    code === 'HTTP_502' ||
    code === 'SSE_DECODE_ERROR' ||
    name === 'providerprotocolerror' ||
    message.includes('upstream sse error event') ||
    message.includes('anthropic sse error event');
  if (!sseLike) {
    return false;
  }
  return (
    upstreamCode.includes('internal_network_failure') ||
    message.includes('internal network failure') ||
    message.includes('network failure') ||
    message.includes('network error') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection reset') ||
    message.includes('timeout') ||
    upstreamCode.includes('upstream_stream_no_content_timeout') ||
    upstreamCode.includes('upstream_stream_content_idle_timeout')
  );
}
