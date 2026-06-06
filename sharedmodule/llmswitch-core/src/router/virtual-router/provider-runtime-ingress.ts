import type { ProviderErrorEvent, ProviderSuccessEvent } from './types.js';

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

type RuntimeRouterHooks = {
  handleProviderError?: (event: ProviderErrorEvent) => void;
  handleProviderSuccess?: (event: ProviderSuccessEvent) => void;
};

type RuntimeQuotaHooks = {
  onProviderError?: (event: ProviderErrorEvent) => void;
  onProviderSuccess?: (event: ProviderSuccessEvent) => void;
};

type RuntimeProviderQuotaHooks = {
  onProviderError?: (event: ProviderErrorEvent) => void;
};

type RuntimeObserverHooks = {
  onProviderErrorReported?: (event: ProviderErrorEvent) => void;
  onProviderSuccessReported?: (event: ProviderSuccessEvent) => void;
};

const runtimeRouterHooks = new Map<unknown, RuntimeRouterHooks>();
const runtimeQuotaHooks = new Map<unknown, RuntimeQuotaHooks>();
const runtimeProviderQuotaHooks = new Map<unknown, RuntimeProviderQuotaHooks>();
const runtimeObserverHooks = new Map<unknown, RuntimeObserverHooks>();

function logIngressHookFailure(stage: string, error: unknown): void {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  try {
    console.warn(`[provider-runtime-ingress] ${stage} failed (non-blocking): ${reason}`);
  } catch {
    // Never throw from logging.
  }
}

function setHookEntry<T extends object>(store: Map<unknown, T>, owner: unknown, hooks?: T): void {
  if (!owner) {
    return;
  }
  if (!hooks) {
    store.delete(owner);
    return;
  }
  store.set(owner, hooks);
}

function dispatchToRouterHooks(event: ProviderErrorEvent | ProviderSuccessEvent, kind: 'error' | 'success'): void {
  for (const hooks of runtimeRouterHooks.values()) {
    try {
      if (kind === 'error') {
        hooks.handleProviderError?.(event as ProviderErrorEvent);
      } else {
        hooks.handleProviderSuccess?.(event as ProviderSuccessEvent);
      }
    } catch (error) {
      logIngressHookFailure(`runtime_router_hooks.${kind}`, error);
    }
  }
}

function dispatchToQuotaHooks(event: ProviderErrorEvent | ProviderSuccessEvent, kind: 'error' | 'success'): void {
  for (const hooks of runtimeQuotaHooks.values()) {
    try {
      if (kind === 'error') {
        hooks.onProviderError?.(event as ProviderErrorEvent);
      } else {
        hooks.onProviderSuccess?.(event as ProviderSuccessEvent);
      }
    } catch (error) {
      logIngressHookFailure(`runtime_quota_hooks.${kind}`, error);
    }
  }
}

function dispatchToProviderQuotaHooks(event: ProviderErrorEvent): void {
  for (const hooks of runtimeProviderQuotaHooks.values()) {
    try {
      hooks.onProviderError?.(event);
    } catch (error) {
      logIngressHookFailure('runtime_provider_quota_hooks.error', error);
    }
  }
}

function dispatchToObserverHooks(event: ProviderErrorEvent | ProviderSuccessEvent, kind: 'error' | 'success'): void {
  for (const hooks of runtimeObserverHooks.values()) {
    try {
      if (kind === 'error') {
        hooks.onProviderErrorReported?.(event as ProviderErrorEvent);
      } else {
        hooks.onProviderSuccessReported?.(event as ProviderSuccessEvent);
      }
    } catch (error) {
      logIngressHookFailure(`runtime_observer_hooks.${kind}`, error);
    }
  }
}

function normalizeProviderErrorEvent(event: ProviderErrorEvent): ProviderErrorEvent {
  const timestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  const code = event.code?.toString() || 'ERR_UNKNOWN';
  const message = event.message || code;
  const stage = event.stage || 'unknown';
  const runtime = (event.runtime || {}) as ProviderErrorEvent['runtime'];
  return {
    code,
    message,
    stage,
    status: event.status,
    recoverable: event.recoverable,
    affectsHealth: event.affectsHealth,
    fatal: event.fatal,
    cooldownOverrideMs: event.cooldownOverrideMs,
    quotaScope: event.quotaScope,
    quotaReason: event.quotaReason,
    resetAt: event.resetAt,
    errorClassification: event.errorClassification,
    runtime,
    timestamp,
    details: event.details
  };
}

function normalizeProviderSuccessEvent(event: ProviderSuccessEvent): ProviderSuccessEvent {
  const timestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  const runtime = (event.runtime || {}) as ProviderSuccessEvent['runtime'];
  return {
    runtime,
    timestamp,
    metadata: event.metadata,
    details: event.details
  };
}

export function setVirtualRouterPolicyRuntimeRouterHooks(owner: unknown, hooks?: RuntimeRouterHooks): void {
  setHookEntry(runtimeRouterHooks, owner, hooks);
}

export function setProviderRuntimeQuotaHooks(owner: unknown, hooks?: RuntimeQuotaHooks): void {
  setHookEntry(runtimeQuotaHooks, owner, hooks);
}

export function setProviderRuntimeProviderQuotaHooks(owner: unknown, hooks?: RuntimeProviderQuotaHooks): void {
  setHookEntry(runtimeProviderQuotaHooks, owner, hooks);
}

export function setProviderRuntimeObserverHooks(owner: unknown, hooks?: RuntimeObserverHooks): void {
  setHookEntry(runtimeObserverHooks, owner, hooks);
}

export function reportProviderErrorToRouterPolicy(event: ProviderErrorEvent): ProviderErrorEvent {
  const normalized = normalizeProviderErrorEvent(event);
  dispatchToRouterHooks(normalized, 'error');
  dispatchToQuotaHooks(normalized, 'error');
  dispatchToProviderQuotaHooks(normalized);
  dispatchToObserverHooks(normalized, 'error');
  return normalized;
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

export function reportProviderSuccessToRouterPolicy(event: ProviderSuccessEvent): ProviderSuccessEvent {
  const normalized = normalizeProviderSuccessEvent(event);
  dispatchToRouterHooks(normalized, 'success');
  dispatchToQuotaHooks(normalized, 'success');
  dispatchToObserverHooks(normalized, 'success');
  return normalized;
}

export function resetProviderRuntimeIngressForTests(): void {
  runtimeRouterHooks.clear();
  runtimeQuotaHooks.clear();
  runtimeProviderQuotaHooks.clear();
  runtimeObserverHooks.clear();
}
// vr.route_availability_floor references:
// - build_unavailable_providers_details
// - collect_recoverable_cooldown_for_key
