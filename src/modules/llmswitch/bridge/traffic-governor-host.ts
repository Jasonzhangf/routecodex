/**
 * Traffic-governor bridge surface.
 *
 * Cross-process traffic governance stays Rust-owned; this host file only
 * exposes the native binding needed by the TS traffic-governor shell.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

function requiredTrafficGovernorBinding<T extends (...args: any[]) => any>(
  capability: string,
  binding: T | undefined
): T {
  if (typeof binding !== 'function') {
    throw new Error(`[traffic-governor] ${capability} not available`);
  }
  return binding;
}

export function trafficGovernorAcquireNativeJson(inputJson: string): Promise<string> {
  const binding = getRouterHotpathJsonBindingSync();
  return requiredTrafficGovernorBinding(
    'trafficGovernorAcquireJson',
    binding.trafficGovernorAcquireJson
  )(inputJson);
}

export function trafficGovernorReleaseNativeJson(inputJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  return requiredTrafficGovernorBinding(
    'trafficGovernorReleaseJson',
    binding.trafficGovernorReleaseJson
  )(inputJson);
}

export function trafficGovernorIsAtCapacityNativeJson(inputJson: string): boolean {
  const binding = getRouterHotpathJsonBindingSync();
  return requiredTrafficGovernorBinding(
    'trafficGovernorIsAtCapacityJson',
    binding.trafficGovernorIsAtCapacityJson
  )(inputJson);
}

export function trafficGovernorObserveOutcomeNativeJson(inputJson: string): void {
  const binding = getRouterHotpathJsonBindingSync();
  requiredTrafficGovernorBinding(
    'trafficGovernorObserveOutcomeJson',
    binding.trafficGovernorObserveOutcomeJson
  )(inputJson);
}
