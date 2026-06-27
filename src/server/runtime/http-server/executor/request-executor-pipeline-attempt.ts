import type { HubPipelineResult } from '../executor-pipeline.js';
import { finalizeRequestExecutorAttemptMetadata } from './request-executor-attempt-state.js';
import type { RetryErrorSnapshot } from './request-executor-error-types.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import {
  hasAlternativeRouteCandidate
} from './request-executor-retry-decision.js';
import {
  normalizeExplicitRoutePoolNative,
  mergeObservedRoutePoolChainNative
} from '../../../../modules/llmswitch/bridge/native-exports.js';

type PipelineAttemptTarget = HubPipelineResult['target'];

const PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts',
  symbol: 'resolveRequestExecutorPipelineAttempt',
  stage: 'request_executor_pipeline_target_observation',
} as const;

// normalizeExplicitRoutePool and mergeObservedRoutePoolChain are now Rust-native.
// See: sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_executor_pipeline_attempt/route_pool.rs

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
  const routingDecision = args.pipelineResult.routingDecision as Record<string, unknown> | undefined;
  const explicitRoutePool = normalizeExplicitRoutePoolNative(
    Array.isArray(routingDecision?.routePool) ? routingDecision?.routePool : routingDecision?.pool
  );
  initialRoutePool = mergeObservedRoutePoolChainNative(initialRoutePool, explicitRoutePool);
  const routePoolForAttempt = initialRoutePool && initialRoutePool.length > 0
    ? [...initialRoutePool]
    : [...explicitRoutePool];

  const providerPayload = args.pipelineResult.providerPayload;
  const target = args.pipelineResult.target;

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
    const hasAlternativeCandidate = hasAlternativeRouteCandidate({
      providerKey: target.providerKey,
      routePool: routePoolForAttempt,
      excludedProviderKeys: args.excludedProviderKeys
    });
    args.logStage('provider.retry.excluded_target_reselected', args.providerRequestId, {
      providerKey: target.providerKey,
      excluded: Array.from(args.excludedProviderKeys),
      attempt: args.attempt,
      hasAlternativeCandidate
    });
    if (!hasAlternativeCandidate) {
      args.excludedProviderKeys.delete(target.providerKey);
      if (args.lastError) {
        throw args.lastError;
      }
      throw Object.assign(new Error(`Virtual router reselected excluded provider ${target.providerKey}`), {
        code: 'ERR_EXCLUDED_PROVIDER_RESELECTED',
        requestId: args.inputRequestId,
        providerKey: target.providerKey
      });
    }
    return {
      kind: 'retry_next_attempt',
      initialRoutePool
    };
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
