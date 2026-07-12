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
