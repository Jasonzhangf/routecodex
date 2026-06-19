import type { HubPipelineResult } from '../executor-pipeline.js';
import { finalizeRequestExecutorAttemptMetadata } from './request-executor-attempt-state.js';
import { resolveExcludedProviderReselectionPlan } from './request-executor-reselection-plan.js';
import { applyRetryExclusionForCurrentProvider } from './request-executor-retry-decision.js';
import { buildProviderTransportBackoffKey, peekProviderTransportBackoffWaitMs } from './request-executor-retry-state.js';
import type { RetryErrorSnapshot } from './request-executor-error-types.js';
import type { BlockingRecoverableRouteHoldState } from './request-executor-error-types.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';

type PipelineAttemptTarget = HubPipelineResult['target'];

const PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts',
  symbol: 'resolveRequestExecutorPipelineAttempt',
  stage: 'request_executor_pipeline_target_observation',
} as const;

function normalizeExplicitRoutePool(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function mergeObservedRoutePoolChain(
  existing: string[] | null,
  observed: string[]
): string[] | null {
  if (observed.length === 0) {
    return existing;
  }
  if (!existing || existing.length === 0) {
    return [...observed];
  }
  const merged = [...existing];
  const seen = new Set(existing);
  for (const candidate of observed) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    merged.push(candidate);
  }
  return merged;
}

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
  blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
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
  const routingDecision = args.pipelineResult.routingDecision as Record<string, unknown> | undefined;
  const explicitRoutePool = normalizeExplicitRoutePool(
    Array.isArray(routingDecision?.routePool) ? routingDecision?.routePool : routingDecision?.pool
  );
  initialRoutePool = mergeObservedRoutePoolChain(initialRoutePool, explicitRoutePool);
  const routePoolForAttempt = initialRoutePool && initialRoutePool.length > 0
    ? [...initialRoutePool]
    : [...explicitRoutePool];

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
  const preserveSameProviderRetry =
    args.blockingRecoverableRouteHoldState?.preserveSameProviderRetry === true
    && (
      (args.blockingRecoverableRouteHoldState.providerKey && args.blockingRecoverableRouteHoldState.providerKey === target?.providerKey)
      || (args.blockingRecoverableRouteHoldState.runtimeKey && args.blockingRecoverableRouteHoldState.runtimeKey === targetRuntimeKey)
    );
  if (pendingTransportBackoffMs > 0 && target?.providerKey) {
    const targetAlreadyExcluded = args.excludedProviderKeys.has(target.providerKey);
    if (targetAlreadyExcluded && !preserveSameProviderRetry) {
      applyRetryExclusionForCurrentProvider({
        providerKey: target.providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      });
      args.logStage('provider.transport_backoff_target_reselected', args.providerRequestId, {
        providerKey: target.providerKey,
        runtimeKey: targetRuntimeKey,
        waitMs: pendingTransportBackoffMs,
        excluded: Array.from(args.excludedProviderKeys),
        attempt: args.attempt,
        targetAlreadyExcluded
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
    if (!initialRoutePool && routePoolForAttempt.length === 0) {
      throw Object.assign(
        new Error(`Virtual router reselected excluded provider ${target.providerKey} without explicit routePool`),
        {
          code: 'ERR_EXCLUDED_PROVIDER_RESELECTED_MISSING_ROUTE_POOL',
          requestId: args.inputRequestId,
          providerKey: target.providerKey
        }
      );
    }
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

  const metadataCenter = MetadataCenter.read(mergedMetadata);
  if (metadataCenter) {
    const targetRecord = target as Record<string, unknown>;
    const modelId =
      typeof targetRecord.modelId === 'string' && targetRecord.modelId.trim()
        ? targetRecord.modelId.trim()
        : undefined;
    const clientModelId =
      typeof targetRecord.clientModelId === 'string' && targetRecord.clientModelId.trim()
        ? targetRecord.clientModelId.trim()
        : undefined;
    metadataCenter.writeProviderObservation(
      'target',
      { ...(target as Record<string, unknown>) },
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
    metadataCenter.writeProviderObservation(
      'providerKey',
      target.providerKey,
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
    metadataCenter.writeProviderObservation(
      'assignedModelId',
      modelId,
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
    metadataCenter.writeProviderObservation(
      'modelId',
      modelId,
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
    metadataCenter.writeProviderObservation(
      'clientModelId',
      clientModelId,
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
    metadataCenter.writeProviderObservation(
      'compatibilityProfile',
      typeof target.compatibilityProfile === 'string' && target.compatibilityProfile.trim()
        ? target.compatibilityProfile.trim()
        : undefined,
      PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
      'selected pipeline target'
    );
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
