import chalk from 'chalk';
import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

export type ProviderErrorLogPayload = {
  stage: string;
  status?: number;
  code?: string;
  runtime?: ProviderErrorEvent['runtime'];
  error: Error & { code?: string; details?: Record<string, unknown> };
};

export function logProviderErrorSummary(payload: ProviderErrorLogPayload): void {
  const { stage, status, code, runtime, error } = payload;
  if (isRateLimitEvent(status, code, error)) {
    const providerTag = buildProviderTag(runtime);
    const suffix = formatRateLimitSummary({ status, details: error?.details, runtime });
    console.warn(chalk.yellow(`[provider-429] ${providerTag} ${error?.message || 'Rate limit exceeded'}${suffix}`));
    return;
  }
  const summary = {
    stage,
    status,
    code,
    providerId: runtime?.providerId,
    pipelineId: runtime?.pipelineId,
    requestId: runtime?.requestId
  };
  const message = error?.message || 'Unknown provider error';
  if (typeof status === 'number' && status >= 500) {
    console.error(chalk.red(`[provider-error] ${message}`), summary);
  } else if (typeof status === 'number' && status >= 400) {
    console.error(chalk.magenta(`[provider-error] ${message}`), summary);
  } else {
    console.error('[provider-error]', message, summary);
  }
}

function isRateLimitEvent(status?: number, code?: string, error?: ProviderErrorLogPayload['error']): boolean {
  if (status === 429) {
    return true;
  }
  const normalizedCode = (code || error?.code || '').toString().toUpperCase();
  if (normalizedCode.includes('429') || normalizedCode.includes('RATE_LIMIT')) {
    return true;
  }
  const normalizedMessage = (error?.message || '').toLowerCase();
  return normalizedMessage.includes('429') || normalizedMessage.includes('rate limit') || normalizedMessage.includes('too many requests');
}

function buildProviderTag(runtime?: ProviderErrorEvent['runtime']): string {
  if (!runtime) {
    return 'provider';
  }
  return runtime.providerKey || runtime.providerId || 'provider';
}

function formatRateLimitSummary(options: {
  status?: number;
  details?: Record<string, unknown>;
  runtime?: ProviderErrorEvent['runtime'];
}): string {
  const entries: string[] = [];
  if (typeof options.status === 'number') {
    entries.push(`status=${options.status}`);
  }
  const detailKeys: Array<'retryAfter' | 'retry_after' | 'retryAfterMs' | 'retry_after_ms' | 'throttleSeconds' | 'throttle_seconds'> = [
    'retryAfter',
    'retry_after',
    'retryAfterMs',
    'retry_after_ms',
    'throttleSeconds',
    'throttle_seconds'
  ];
  for (const key of detailKeys) {
    const value = options.details?.[key];
    if (value !== undefined) {
      entries.push(`${key}=${value}`);
    }
  }
  if (options.runtime?.providerKey) {
    entries.push(`providerKey=${options.runtime.providerKey}`);
  }
  if (options.runtime?.routeName) {
    entries.push(`route=${options.runtime.routeName}`);
  }
  if (options.runtime?.requestId) {
    entries.push(`requestId=${options.runtime.requestId}`);
  }
  return entries.length ? ` (${entries.join(', ')})` : '';
}
