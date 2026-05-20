import type { HubPipelineResult } from '../executor-pipeline.js';
import { finalizeRequestExecutorAttemptMetadata } from './request-executor-attempt-state.js';
import { resolveExcludedProviderReselectionPlan } from './request-executor-reselection-plan.js';
import { applyRetryExclusionForCurrentProvider, hasAlternativeRouteCandidate } from './request-executor-retry-decision.js';
import { buildProviderTransportBackoffKey, peekProviderTransportBackoffWaitMs } from './request-executor-retry-state.js';
import type { RetryErrorSnapshot } from './request-executor-error-types.js';

type PipelineAttemptTarget = HubPipelineResult['target'];

export type ResolvedRequestExecutorPipelineAttempt =
  | {
    kind: 'retry_next_attempt';
    initialRoutePool: string[] | null;
  }
  | {
    kind: 'resolved';
    mergedMetadata: Record<string, unknown>;
    mergedClientHeaders: Record<string, string> | undefined;
    routePoolForAttempt: string[];
    providerPayload: Record<string, unknown>;
    target: PipelineAttemptTarget;
    initialRoutePool: string[] | null;
  };

export function resolveRequestExecutorPipelineAttempt(args: {
  inputRequestId: string;
  providerRequestId: string;
  attempt: number;
  metadataForAttempt: Record<string, unknown>;
  pipelineResult: HubPipelineResult;
  clientHeadersForAttempt: Record<string, string> | undefined;
  clientRequestId: string;
  clientAbortSignal: AbortSignal | undefined;
  initialRoutePool: string[] | null;
  excludedProviderKeys: Set<string>;
  lastError: unknown;
  throwIfClientAbortSignalAborted: (abortSignal: AbortSignal | undefined) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  extractRetryErrorSnapshot: (error: unknown) => RetryErrorSnapshot;
  hubStartedAtMs: number;
  pipelineLabel: string;
}): ResolvedRequestExecutorPipelineAttempt {
  const { mergedMetadata, mergedClientHeaders } = finalizeRequestExecutorAttemptMetadata({
    requestId: args.inputRequestId,
    metadataForAttempt: args.metadataForAttempt,
    pipelineResult: args.pipelineResult,
    clientHeadersForAttempt: args.clientHeadersForAttempt,
    clientRequestId: args.clientRequestId
  });
  args.throwIfClientAbortSignalAborted(args.clientAbortSignal);
  args.logStage(`${args.pipelineLabel}.completed`, args.providerRequestId, {
    route: args.pipelineResult.routingDecision?.routeName,
    target: args.pipelineResult.target?.providerKey,
    elapsedMs: Date.now() - args.hubStartedAtMs,
    attempt: args.attempt
  });

  let initialRoutePool = args.initialRoutePool;
  if (!initialRoutePool && Array.isArray(args.pipelineResult.routingDecision?.pool)) {
    initialRoutePool = [...args.pipelineResult.routingDecision.pool];
  }
  const routePoolForAttempt = Array.isArray(args.pipelineResult.routingDecision?.pool)
    ? args.pipelineResult.routingDecision.pool
    : (initialRoutePool ?? []);

  const providerPayload = args.pipelineResult.providerPayload;
  const target = args.pipelineResult.target;

  const targetRuntimeKey =
    target && typeof target.runtimeKey === 'string' && target.runtimeKey.trim()
      ? target.runtimeKey.trim()
      : undefined;
  const providerTransportBackoffKey = buildProviderTransportBackoffKey({
    providerKey: target?.providerKey,
    runtimeKey: targetRuntimeKey
  });
  const pendingTransportBackoffMs =
    providerTransportBackoffKey
      ? peekProviderTransportBackoffWaitMs(providerTransportBackoffKey)
      : 0;
  if (pendingTransportBackoffMs > 0 && target?.providerKey) {
    const hasAlternativeCandidate = hasAlternativeRouteCandidate({
      providerKey: target.providerKey,
      routePool: routePoolForAttempt,
      excludedProviderKeys: args.excludedProviderKeys
    });
    if (hasAlternativeCandidate) {
      applyRetryExclusionForCurrentProvider({
        providerKey: target.providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      });
      args.logStage('provider.transport_backoff_target_reselected', args.providerRequestId, {
        providerKey: target.providerKey,
        runtimeKey: targetRuntimeKey,
        waitMs: pendingTransportBackoffMs,
        excluded: Array.from(args.excludedProviderKeys),
        attempt: args.attempt
      });
      return {
        kind: 'retry_next_attempt',
        initialRoutePool
      };
    }
  }

  if (!providerPayload || !target?.providerKey) {
    throw Object.assign(new Error('Virtual router did not produce a provider target'), {
      code: 'ERR_NO_PROVIDER_TARGET',
      requestId: args.inputRequestId
    });
  }
  if (args.excludedProviderKeys.has(target.providerKey)) {
    const reselectedExcludedPlan = resolveExcludedProviderReselectionPlan({
      providerKey: target.providerKey,
      routePool: routePoolForAttempt,
      excludedProviderKeys: args.excludedProviderKeys,
      lastError: args.lastError,
      extractRetryErrorSnapshot: args.extractRetryErrorSnapshot
    });
    args.logStage('provider.retry.excluded_target_reselected', args.providerRequestId, {
      providerKey: target.providerKey,
      excluded: Array.from(args.excludedProviderKeys),
      attempt: args.attempt,
      hasAlternativeCandidate: reselectedExcludedPlan.hasAlternativeCandidate
    });
    if (!reselectedExcludedPlan.keepExcludedForNextAttempt) {
      args.excludedProviderKeys.delete(target.providerKey);
    } else {
      if (reselectedExcludedPlan.hasAlternativeCandidate) {
        return {
          kind: 'retry_next_attempt',
          initialRoutePool
        };
      }
      if (args.lastError) {
        throw args.lastError;
      }
      throw Object.assign(new Error(`Virtual router reselected excluded provider ${target.providerKey}`), {
        code: 'ERR_EXCLUDED_PROVIDER_RESELECTED',
        requestId: args.inputRequestId,
        providerKey: target.providerKey
      });
    }
  }

  mergedMetadata.target = target;
  if (typeof target.compatibilityProfile === 'string' && target.compatibilityProfile.trim()) {
    mergedMetadata.compatibilityProfile = target.compatibilityProfile.trim();
  } else if (Object.prototype.hasOwnProperty.call(mergedMetadata, 'compatibilityProfile')) {
    delete mergedMetadata.compatibilityProfile;
  }

  return {
    kind: 'resolved',
    mergedMetadata,
    mergedClientHeaders,
    routePoolForAttempt,
    providerPayload,
    target,
    initialRoutePool
  };
}
