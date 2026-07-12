/**
 * Provider runtime ingress native bridge surface.
 *
 * Provider success/error routing policy ingress remains Rust/NAPI-owned; this
 * host exposes only provider-runtime-ingress capabilities.
 */

import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
} from '../../../types/llmswitch-local-types.js';
import { getRouterHotpathJsonBindingSync } from './native-exports.js';

function requireProviderRuntimeIngressFn<T extends (...args: any[]) => unknown>(
  capability: string,
): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${capability} not available`);
  }
  return fn as T;
}

export function assertProviderRuntimeIngressNativeAvailable(): void {
  requireProviderRuntimeIngressFn<(inputJson: string) => string>('reportProviderErrorToRouterPolicyJson');
  requireProviderRuntimeIngressFn<(inputJson: string) => string>('reportProviderSuccessToRouterPolicyJson');
}

export function reportProviderErrorToRouterPolicyNative(
  event: ProviderErrorEvent,
): ProviderErrorEvent {
  const fn = requireProviderRuntimeIngressFn<(inputJson: string) => string>('reportProviderErrorToRouterPolicyJson');
  return JSON.parse(fn(JSON.stringify(event))) as ProviderErrorEvent;
}

export function reportProviderSuccessToRouterPolicyNative(
  event: ProviderSuccessEvent,
): ProviderSuccessEvent {
  const fn = requireProviderRuntimeIngressFn<(inputJson: string) => string>('reportProviderSuccessToRouterPolicyJson');
  return JSON.parse(fn(JSON.stringify(event))) as ProviderSuccessEvent;
}
