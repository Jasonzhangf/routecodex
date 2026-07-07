import {
  type ProviderErrorEvent,
  type ProviderSuccessEvent,
} from './virtual-router-contracts.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type {
  ProviderErrorEvent,
  ProviderErrorRuntimeMetadata,
  ProviderSuccessEvent,
  ProviderSuccessRuntimeMetadata
} from './virtual-router-contracts.js';

export type InternalRouterPolicyErrorSource = {
  code: string;
  message: string;
  stage: string;
  runtime: ProviderErrorEvent['runtime'];
  details?: Record<string, unknown>;
  status?: number;
  recoverable?: boolean;
  affectsHealth?: boolean;
  fatal?: boolean;
  errorClassification?: string;
};

export type ErrorErr04RouterPolicyApplied = ProviderErrorEvent;

function readNativeFunction(name: string): ((...args: string[]) => unknown) {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  if (typeof fn !== 'function') {
    return failNativeRequired<(...args: string[]) => unknown>(name, 'missing native provider runtime ingress export');
  }
  return fn as (...args: string[]) => unknown;
}

function invokeProviderRuntimeIngress<T>(name: string, payload?: unknown): T {
  const fn = readNativeFunction(name);
  const args = payload === undefined ? [] : [JSON.stringify(payload)];
  const raw = fn(...args);
  if (typeof raw !== 'string' || !raw) {
    return failNativeRequired<T>(name, 'empty result');
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return failNativeRequired<T>(name, 'invalid result');
  }
}

export function reportProviderErrorToRouterPolicy(event: ProviderErrorEvent): ProviderErrorEvent {
  return invokeProviderRuntimeIngress<ProviderErrorEvent>('reportProviderErrorToRouterPolicyJson', event);
}

export function reportProviderSuccessToRouterPolicy(event: ProviderSuccessEvent): ProviderSuccessEvent {
  return invokeProviderRuntimeIngress<ProviderSuccessEvent>('reportProviderSuccessToRouterPolicyJson', event);
}

export function report_internal_error_err_02_host_to_router_policy(source: InternalRouterPolicyErrorSource): ProviderErrorEvent {
  return reportProviderErrorToRouterPolicy({
    code: source.code,
    message: source.message,
    stage: source.stage,
    status: source.status,
    recoverable: source.recoverable,
    affectsHealth: source.affectsHealth,
    fatal: source.fatal,
    errorClassification: source.errorClassification,
    runtime: source.runtime,
    timestamp: Date.now(),
    details: source.details
  });
}

export function apply_error_err_04_router_policy_from_error_err_03_runtime(
  source: InternalRouterPolicyErrorSource
): ErrorErr04RouterPolicyApplied {
  return report_internal_error_err_02_host_to_router_policy(source);
}

export function resetProviderRuntimeIngressForTests(): void {
  invokeProviderRuntimeIngress<boolean>('resetProviderRuntimeIngressForTestsJson');
}
