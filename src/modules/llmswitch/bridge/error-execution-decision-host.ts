/**
 * ErrorErr05 execution-decision bridge surface.
 *
 * Retry execution policy and route availability decisions remain native-owned;
 * this host only exposes the narrow calls consumed by request executor shells.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

export {
  resolveProviderRetryExecutionPolicyNative,
} from './native-exports.js';

export {
  resolveErrorErr05RouteAvailabilityDecisionNative,
} from './route-availability-host.js';

export function isRateLimitLikeErrorNative(message: string, ...codes: Array<string | undefined>): boolean {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.isRateLimitLikeErrorJson;
  if (typeof fn !== 'function') {
    throw new Error('[error-execution-decision-host] isRateLimitLikeErrorJson not available');
  }
  const raw = fn(JSON.stringify({
    message,
    codes: codes.filter((code): code is string => typeof code === 'string'),
  }));
  const parsed = JSON.parse(raw) as { result?: unknown };
  if (typeof parsed.result !== 'boolean') {
    throw new Error('[error-execution-decision-host] isRateLimitLikeErrorJson returned invalid result');
  }
  return parsed.result;
}

export type ErrorErr02HostCapturedInput = {
  stage?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  errorMessage?: string;
  errorName?: string;
  detailReason?: string;
  detailUpstreamCode?: string;
  detailUpstreamMessage?: string;
  responseErrorMessage?: string;
  responseErrorCode?: string;
  responseErrorType?: string;
  responseErrorParam?: string;
  providerStatusCode?: number;
};

export type ErrorErr03RuntimeClassifiedDecision = {
  classification?: 'recoverable' | 'unrecoverable';
  clientDisconnect: boolean;
  networkTransportLike: boolean;
};

export function classifyErrorErr02HostCapturedNative(
  input: ErrorErr02HostCapturedInput
): ErrorErr03RuntimeClassifiedDecision {
  const fn = getRouterHotpathJsonBindingSync().classifyErrorErr02HostCapturedJson;
  if (typeof fn !== 'function') {
    throw new Error('[error-execution-decision-host] classifyErrorErr02HostCapturedJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify(input))) as Partial<ErrorErr03RuntimeClassifiedDecision> & {
    classification?: ErrorErr03RuntimeClassifiedDecision['classification'] | null;
  };
  if (
    (parsed.classification !== undefined
      && parsed.classification !== null
      && parsed.classification !== 'recoverable'
      && parsed.classification !== 'unrecoverable')
    || typeof parsed.clientDisconnect !== 'boolean'
    || typeof parsed.networkTransportLike !== 'boolean'
  ) {
    throw new Error('[error-execution-decision-host] classifyErrorErr02HostCapturedJson returned invalid result');
  }
  return {
    ...(parsed.classification ? { classification: parsed.classification } : {}),
    clientDisconnect: parsed.clientDisconnect,
    networkTransportLike: parsed.networkTransportLike,
  };
}
