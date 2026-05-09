import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

export function extractProviderKey(event: ProviderErrorEvent): string | null {
  const runtime = event.runtime as { providerKey?: unknown; target?: unknown } | undefined;
  const direct =
    runtime && typeof runtime.providerKey === 'string' && runtime.providerKey.trim()
      ? runtime.providerKey.trim()
      : null;
  if (direct) {
    return direct;
  }
  const target = runtime && runtime.target;
  if (target && typeof target === 'object') {
    const targetKey = (target as { providerKey?: unknown }).providerKey;
    if (typeof targetKey === 'string' && targetKey.trim()) {
      return targetKey.trim();
    }
  }
  return null;
}

export function isFatalForQuota(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  const code = typeof event.code === 'string' ? event.code.toUpperCase() : '';
  const stage = typeof event.stage === 'string' ? event.stage.toLowerCase() : '';


  if (status === 401 || status === 402 || status === 403 || status === 434) {
    return true;
  }
  if (code.includes('AUTH') || code.includes('UNAUTHORIZED')) {
    return true;
  }
  if (code.includes('CONFIG')) {
    return true;
  }
  if (stage.includes('compat')) {
    return true;
  }
  if (event.recoverable === false && status !== undefined && status >= 500) {
    return true;
  }
  return false;
}

export function isAkBlocked434(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  if (status === 434) {
    return true;
  }

  const message = typeof event.message === 'string' ? event.message.toLowerCase() : '';
  if (message.includes('access to the current ak has been blocked due to unauthorized requests')) {
    return true;
  }
  if (message.includes('business error (434)')) {
    return true;
  }

  const details = event.details && typeof event.details === 'object'
    ? (event.details as Record<string, unknown>)
    : null;
  if (!details) {
    return false;
  }

  const upstreamCode = typeof details.upstreamCode === 'string'
    ? details.upstreamCode.trim().toLowerCase()
    : '';
  if (upstreamCode === '434') {
    return true;
  }

  const statusCode = typeof details.statusCode === 'number' ? details.statusCode : undefined;
  if (statusCode === 434) {
    return true;
  }

  const upstreamMessage = typeof details.upstreamMessage === 'string'
    ? details.upstreamMessage.toLowerCase()
    : '';
  return upstreamMessage.includes('access to the current ak has been blocked due to unauthorized requests');
}
