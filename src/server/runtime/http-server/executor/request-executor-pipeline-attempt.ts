import type { HubPipelineResult } from '../executor-pipeline.js';
import { finalizeRequestExecutorAttemptMetadata } from './request-executor-attempt-state.js';
import type { RetryErrorSnapshot } from './request-executor-error-types.js';
import {
  hasRuntimeCarrier,
  writeProviderObservationSlot,
  writeRuntimeControlSlot
} from '../metadata-center/request-truth-readers.js';
import {
  resolveErrorErr05RouteAvailabilityDecision
} from './request-executor-core-utils.js';
import {
  normalizeExplicitRoutePoolNative,
  mergeObservedRoutePoolChainNative
} from '../../../../modules/llmswitch/bridge/request-executor-pipeline-attempt-host.js';

type PipelineAttemptTarget = HubPipelineResult['target'];

const PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts',
  symbol: 'resolveRequestExecutorPipelineAttempt',
  stage: 'request_executor_pipeline_target_observation',
} as const;

const PIPELINE_ATTEMPT_SELECTION_COMMIT_WRITER = {
  module: 'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts',
  symbol: 'commitRequestExecutorAttemptSelection',
  stage: 'request_executor_pipeline_selection_commit',
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

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commitRequestExecutorAttemptSelection(args: {
  metadata: Record<string, unknown>;
  routingDecision: Record<string, unknown> | undefined;
  target: PipelineAttemptTarget;
}): void {
  const { metadata, routingDecision, target } = args;
  const targetRecord = target as Record<string, unknown>;
  const modelId = readTrimmedString(targetRecord.modelId);
  const clientModelId = readTrimmedString(targetRecord.clientModelId);
  const routeName = readTrimmedString(routingDecision?.routeName);
  const routeId = readTrimmedString(routingDecision?.routeId);
  const providerProtocol = readTrimmedString(routingDecision?.providerProtocol);
  if (!providerProtocol) {
    throw Object.assign(new Error('Virtual router selection missing providerProtocol'), {
      code: 'ERR_VR_SELECTION_MISSING_PROVIDER_PROTOCOL',
      providerKey: target.providerKey,
      routeName
    });
  }

  writeProviderObservationSlot({
    target: metadata,
    key: 'target',
    value: { ...(target as Record<string, unknown>) },
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeProviderObservationSlot({
    target: metadata,
    key: 'providerKey',
    value: target.providerKey,
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeProviderObservationSlot({
    target: metadata,
    key: 'assignedModelId',
    value: modelId,
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeProviderObservationSlot({
    target: metadata,
    key: 'modelId',
    value: modelId,
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeProviderObservationSlot({
    target: metadata,
    key: 'clientModelId',
    value: clientModelId,
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeProviderObservationSlot({
    target: metadata,
    key: 'compatibilityProfile',
    value: readTrimmedString(target.compatibilityProfile),
    writer: PIPELINE_ATTEMPT_PROVIDER_OBSERVATION_WRITER,
    reason: 'selected pipeline target'
  });
  writeRuntimeControlSlot({
    target: metadata,
    key: 'routeName',
    value: routeName,
    writer: PIPELINE_ATTEMPT_SELECTION_COMMIT_WRITER,
    reason: 'selected pipeline route'
  });
  writeRuntimeControlSlot({
    target: metadata,
    key: 'routeId',
    value: routeId,
    writer: PIPELINE_ATTEMPT_SELECTION_COMMIT_WRITER,
    reason: 'selected pipeline route'
  });
  writeRuntimeControlSlot({
    target: metadata,
    key: 'providerProtocol',
    value: providerProtocol,
    writer: PIPELINE_ATTEMPT_SELECTION_COMMIT_WRITER,
    reason: 'selected pipeline provider protocol'
  });
}

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
  routeTiersForAttempt?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
  defaultRouteTiersForAttempt?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
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
    const availabilityDecision = resolveErrorErr05RouteAvailabilityDecision({
      routeName: readTrimmedString(routingDecision?.routeName),
      routePool: routePoolForAttempt,
      routeTiers: args.routeTiersForAttempt ?? [],
      defaultRouteTiers: args.defaultRouteTiersForAttempt ?? [],
      excludedProviderKeys: args.excludedProviderKeys,
      providerKey: target.providerKey,
      routingDecisionRoutePoolPresent: Array.isArray(routingDecision?.routePool) && routingDecision.routePool.length > 0,
    });
    args.logStage('provider.retry.excluded_target_reselected', args.providerRequestId, {
      providerKey: target.providerKey,
      excluded: Array.from(args.excludedProviderKeys),
      attempt: args.attempt,
      hasAlternativeCandidate: availabilityDecision.hasAlternativeCandidate,
      routePoolIsAuthoritative: availabilityDecision.routePoolAuthoritative,
      defaultTierAvailable: availabilityDecision.defaultPoolAvailable,
      isVerifiedLastProvider: availabilityDecision.verifiedLastProvider,
      reasonCode: availabilityDecision.reasonCode
    });
    if (!availabilityDecision.hasAlternativeCandidate && availabilityDecision.verifiedLastProvider) {
      args.logStage('provider.retry.excluded_target_reselected_last_provider', args.providerRequestId, {
        providerKey: target.providerKey,
        excluded: Array.from(args.excludedProviderKeys),
        attempt: args.attempt
      });
    } else {
      throw Object.assign(
        new Error(
          availabilityDecision.hasAlternativeCandidate
            ? `Virtual router reselected excluded provider ${target.providerKey} while alternatives remain`
            : `Virtual router reselected excluded provider ${target.providerKey} without verified last-provider truth`
        ),
        {
          code: 'ERR_EXCLUDED_PROVIDER_RESELECTED',
          requestId: args.inputRequestId,
          providerKey: target.providerKey,
          excluded: Array.from(args.excludedProviderKeys),
          attempt: args.attempt,
          hasAlternativeCandidate: availabilityDecision.hasAlternativeCandidate,
          isVerifiedLastProvider: availabilityDecision.verifiedLastProvider
        }
      );
    }
  }

  if (hasRuntimeCarrier(mergedMetadata)) {
    commitRequestExecutorAttemptSelection({
      metadata: mergedMetadata,
      routingDecision,
      target
    });
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
