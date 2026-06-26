import type { ProviderErrorAugmented } from './provider-error-types.js';
import {
  extractProviderFailureStatusCode,
  isProviderFailureNetworkTransportLike,
  resolveProviderFailureOutcome,
  type ProviderFailureClassification
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
  isRateLimit: boolean;
};

export type ProviderErrorClassifierOptions = {
  error: unknown;
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

  const statusText = String(statusCode ?? '');
  const msgLower = message.toLowerCase();

  const isRateLimit = statusText.includes('429') || msgLower.includes('429');
  const outcome = resolveProviderFailureOutcome({
    error: err,
    stage: 'provider.http',
    statusCode,
    errorCode: typeof err.code === 'string' ? err.code : undefined,
    upstreamCode: typeof upstreamCode === 'string' ? upstreamCode : undefined,
    reason: message,
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
    isRateLimit,
  };
}

export function extractStatusCodeFromError(error: ProviderErrorAugmented): number | undefined {
  return extractProviderFailureStatusCode(error);
}

export function looksLikeNetworkTransportError(error: ProviderErrorAugmented, msgLower: string): boolean {
  return isProviderFailureNetworkTransportLike(error) || msgLower.includes('network error');
}
