import {
  describeProviderFailureDecision,
  resolveProviderFailureExclusionDecision,
  resolveProviderFailureRetryEligibility
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  readString,
  normalizeCodeKey,
  normalizeRuntimeKey
} from './request-executor-error-shared.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';
import {
  resolveRequestExecutorProviderErrorClassification
} from './request-executor-provider-failure.js';
import type {
  ProviderRetryEligibilityPlan,
  ProviderRetryExclusionPlan,
  ProviderRetryExecutionPlan,
  ProviderRetrySwitchPlan,
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

const MAX_CONTEXT_OVERFLOW_RETRIES = 3;

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
};

function isNetworkTransportLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  const statusCode = typeof (record as { statusCode?: unknown }).statusCode === 'number'
    ? ((record as { statusCode?: number }).statusCode)
    : undefined;
  const known = normalizeKnownProviderError({
    statusCode,
    code: record.code,
    upstreamCode: (record as { upstreamCode?: unknown }).upstreamCode,
    message: record.message,
  });
  if (known?.code === '0.1000' || known?.code === '0.2000' || known?.code === '0.3000' || known?.code === '0.4000' || known?.code === '0.6000') {
    return true;
  }
  const code = typeof record.code === 'string' ? record.code.trim().toUpperCase() : '';
  if (
    code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'ENOTFOUND'
    || code === 'EAI_AGAIN'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
    || code === 'ECONNABORTED'
  ) {
    return true;
  }
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    return true;
  }
  return (
    message.includes('fetch failed')
    || message.includes('network timeout')
    || message.includes('socket hang up')
    || message.includes('client network socket disconnected')
    || message.includes('tls handshake timeout')
    || message.includes('unable to verify the first certificate')
    || message.includes('network error')
    || message.includes('temporarily unreachable')
  );
}

export function hasAlternativeRouteCandidate(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  const currentProviderKey = readString(args.providerKey);
  if (!Array.isArray(args.routePool) || args.routePool.length === 0) {
    return true;
  }
  return args.routePool.some((candidate) => {
    const normalized = readString(candidate);
    if (!normalized) {
      return false;
    }
    if (currentProviderKey && normalized === currentProviderKey) {
      return false;
    }
    return !args.excludedProviderKeys.has(normalized);
  });
}

function hasExplicitAlternativeRouteCandidate(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  return hasAlternativeRouteCandidate(args);
}

function resolveRuntimeKeyForProvider(
  runtimeManager: RuntimeManager,
  providerKey: string
): string | undefined {
  return normalizeRuntimeKey(runtimeManager.resolveRuntimeKey(providerKey));
}

export function applyRetryExclusionForCurrentProvider(args: {
  providerKey?: string;
  excludedProviderKeys: Set<string>;
}): boolean {
  const providerKey = readString(args.providerKey);
  if (!providerKey) {
    return false;
  }
  args.excludedProviderKeys.add(providerKey);
  return true;
}

function isProviderTrafficSaturatedRetryError(args: {
  status?: number;
  error: unknown;
}): boolean {
  const code = normalizeCodeKey((args.error as { code?: unknown } | undefined)?.code);
  const upstreamCode = normalizeCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode);
  if (code === 'PROVIDER_TRAFFIC_SATURATED' || upstreamCode === 'PROVIDER_TRAFFIC_SATURATED') {
    return true;
  }
  return args.status === 429 && code === 'PROVIDER_TRAFFIC_SATURATED';
}

export function resolveProviderRetryExclusionPlan(args: {
  providerKey?: string;
  status?: number;
  error: unknown;
  classification?: RequestExecutorProviderErrorClassification;
  attempt?: number;
  promptTooLong: boolean;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): ProviderRetryExclusionPlan {
  const providerKey = readString(args.providerKey);
  if (!providerKey) {
    return {
      excludedCurrentProvider: false
    };
  }
  const is429 = args.status === 429;
  const hasAlternativeCandidate = hasExplicitAlternativeRouteCandidate({
    providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });

  // Unified recoverable rule: after 3 consecutive recoverable failures on current provider,
  // exclude this provider so the same request can move to next priority target.
  // This intentionally applies to 429/5xx/network recoverable classes without per-error special cases.
  if (args.classification === 'recoverable' && (args.attempt ?? 0) >= 3 && hasAlternativeCandidate) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      })
    };
  }

  const exclusionDecision = resolveProviderFailureExclusionDecision({
    promptTooLong: args.promptTooLong,
    classification: args.classification,
    statusCode: args.status,
    errorCode: normalizeCodeKey((args.error as { code?: unknown } | undefined)?.code),
    upstreamCode: normalizeCodeKey((args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode),
    isProviderTrafficSaturated: isProviderTrafficSaturatedRetryError({ status: args.status, error: args.error }),
    isNetworkTransport: isNetworkTransportLikeError(args.error),
    hasAlternativeCandidate,
    is429
  });
  if (exclusionDecision.excludeCurrentProvider) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      })
    };
  }
  return {
    excludedCurrentProvider: false
  };
}

function excludeProvidersSharingRuntimeFromRoutePool(args: {
  routePool: string[];
  runtimeKey: string;
  runtimeManager: RuntimeManager;
  excludedProviderKeys: Set<string>;
}): string[] {
  const currentRuntimeKey = normalizeRuntimeKey(args.runtimeKey);
  if (!currentRuntimeKey) {
    return [];
  }
  const added: string[] = [];
  for (const providerKey of args.routePool) {
    if (typeof providerKey !== 'string') {
      continue;
    }
    const normalizedProviderKey = providerKey.trim();
    if (!normalizedProviderKey) {
      continue;
    }
    const candidateRuntimeKey = resolveRuntimeKeyForProvider(args.runtimeManager, normalizedProviderKey);
    if (candidateRuntimeKey !== currentRuntimeKey) {
      continue;
    }
    if (args.excludedProviderKeys.has(normalizedProviderKey)) {
      continue;
    }
    args.excludedProviderKeys.add(normalizedProviderKey);
    added.push(normalizedProviderKey);
  }
  return added;
}

export function isLastAvailableProvider429(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
  retryError: RetryErrorSnapshot;
}): boolean {
  const status = typeof args.retryError.statusCode === 'number' ? args.retryError.statusCode : undefined;
  const errorCode = normalizeCodeKey(args.retryError.errorCode);
  const upstreamCode = normalizeCodeKey(args.retryError.upstreamCode);
  const known = normalizeKnownProviderError({
    statusCode: status,
    code: errorCode,
    upstreamCode,
    message: args.retryError.reason,
  });
  const is429 = known?.code?.startsWith('429.') || status === 429 || errorCode === 'HTTP_429' || upstreamCode === 'HTTP_429';
  if (!is429 || !readString(args.providerKey)) {
    return false;
  }
  if (!Array.isArray(args.routePool) || args.routePool.length === 0) {
    return true;
  }
  return !hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
}

export function resolveProviderRetryEligibilityPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
}): ProviderRetryEligibilityPlan {
  const eligibility = resolveProviderFailureRetryEligibility({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    classification: resolveRequestExecutorProviderErrorClassification({
      error: args.error,
      retryError: args.retryError,
      stage: args.stage
    }),
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries ?? MAX_CONTEXT_OVERFLOW_RETRIES,
    allowNonPolicyRetry: false,
    stageOutsideProviderFailurePolicy: args.stage === 'host.response_contract'
  });
  return {
    shouldRetry: eligibility.shouldRetry,
    blockingRecoverable: eligibility.blockingRecoverable
  };
}

export function buildProviderRetrySwitchPlan(args: {
  runtimeKey?: string;
  routePool?: string[];
  runtimeManager?: RuntimeManager;
  excludedProviderKeys: Set<string>;
  excludedCurrentProvider: boolean;
  promptTooLong?: boolean;
  error?: unknown;
  retryError?: RetryErrorSnapshot;
  backoffScope: ProviderRetryExecutionPlan['backoffScope'];
}): ProviderRetrySwitchPlan {
  const switchAction =
    args.excludedCurrentProvider ? 'exclude_and_reroute' : 'retry_same_provider';
  let runtimeScopeExcluded: string[] = [];
  const isProviderTrafficSaturated =
    args.retryError?.errorCode === 'PROVIDER_TRAFFIC_SATURATED'
    || (typeof (args.error as { code?: unknown } | undefined)?.code === 'string'
      && (args.error as { code?: string }).code === 'PROVIDER_TRAFFIC_SATURATED');
  if (
    !args.promptTooLong
    && args.excludedCurrentProvider
    && isProviderTrafficSaturated
    && Array.isArray(args.routePool)
    && args.routePool.length > 0
    && args.runtimeManager
  ) {
    runtimeScopeExcluded = excludeProvidersSharingRuntimeFromRoutePool({
      routePool: args.routePool,
      runtimeKey: args.runtimeKey ?? '',
      runtimeManager: args.runtimeManager,
      excludedProviderKeys: args.excludedProviderKeys
    });
  }
  return {
    switchAction,
    decisionLabel: describeProviderFailureDecision({
      action: switchAction === 'exclude_and_reroute' ? 'reroute_explicit_alternative' : 'retry_same_provider',
      backoffScope: args.backoffScope ?? 'attempt'
    }),
    runtimeScopeExcluded,
    runtimeScopeExcludedCount: runtimeScopeExcluded.length
  };
}
