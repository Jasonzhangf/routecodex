import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { HubPipeline, ProviderHandle, ProviderProtocol } from './types.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import {
  computeProviderFailureBackoffDelayMs,
  describeProviderFailureDecision,
  isBlockingRecoverableProviderFailure,
  resolveProviderFailureExclusionDecision,
  isProviderFailureHealthNeutral,
  normalizeProviderFailureCodeKey,
  resolveProviderFailureRetryEligibility,
  resolveProviderFailureClassification,
  resolveProviderFailureActionPlan,
  type ProviderFailureClassification
} from '../../../providers/core/runtime/provider-failure-policy.js';
import type { StatsManager } from './stats-manager.js';
import {
  buildRequestMetadata,
  cloneClientHeaders,
  decorateMetadataForAttempt,
  ensureClientHeadersOnPayload,
  resolveClientRequestId
} from './executor-metadata.js';
import {
  rebindResponsesConversationRequestId,
  captureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId
} from '../../../modules/llmswitch/bridge.js';
import {
  convertProviderResponseIfNeeded as convertProviderResponseWithBridge
} from './executor/provider-response-converter.js';
import { ensureHubPipeline, runHubPipeline } from './executor-pipeline.js';

// Import from new executor submodules
import {
  isVerboseErrorLoggingEnabled
} from './executor/env-config.js';
import {
  resolveMaxProviderAttempts,
  isPromptTooLongError
} from './executor/retry-engine.js';
import { isClientDisconnectAbortError } from './executor-provider.js';
import {
  type SseWrapperErrorInfo
} from './executor/sse-error-handler.js';
import {
  type UsageMetrics,
  extractUsageFromResult,
  mergeUsageMetrics
} from './executor/usage-aggregator.js';
import {
  bindSessionConversationSession,
  extractStatusCodeFromError,
  isSseDecodeRetryableNetworkError,
  isSseDecodeRateLimitError
} from './executor/request-retry-helpers.js';
import {
  extractProviderModel,
  extractResponseStatus,
  normalizeProviderResponse,
  resolveRequestSemantics,
  describeRequestSemanticsResolution
} from './executor/provider-response-utils.js';
import {
  isPoolExhaustedPipelineError,
  mergeMetadataPreservingDefined,
  resolvePoolCooldownCandidateProviderCount,
  resolvePoolCooldownWaitMs,
  writeInboundClientSnapshot
} from './executor/request-executor-core-utils.js';
import {
  type RequestExecutorFailureState,
  applyResolveFailureState,
  applySendFailureState
} from './executor/request-executor-failure-state.js';
import {
  isWebLikeRuntimeForTraffic,
  resolveProviderTrafficSoftWaitTimeoutMs
} from './executor/request-executor-traffic-soft-wait.js';
import {
  asFlatRecord,
  persistGoalStateFromMergedMetadata
} from './executor/goal-state-persistence.js';

import { initializeRequestExecutorRequestState } from './executor/request-executor-request-state.js';
import { prepareRequestExecutorAttemptState } from './executor/request-executor-attempt-state.js';
import { resolveProviderRuntimeOrThrow } from './executor/provider-runtime-resolver.js';
import { resolveProviderRequestContext } from './executor/provider-request-context.js';
import { isServerToolEnabled } from './servertool-admin-state.js';
import { registerRequestLogContext } from '../../utils/request-log-color.js';
import { getClientConnectionAbortSignal } from '../../utils/client-connection-state.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../utils/finish-reason.js';
import { allowSnapshotLocalDiskWrite } from '../../../utils/snapshot-local-disk-gate.js';
import { writeProviderSnapshot } from '../../../providers/core/utils/snapshot-writer.js';
import {
  hasRequestedToolsInSemantics,
  isRequiredToolCallTurn,
  isToolResultFollowupTurn
} from './executor/request-executor-request-semantics.js';
import {
  extractRequestExecutorProviderErrorStage,
  isHostRequestExecutorErrorStage,
  isRequestExecutorProviderErrorStage,
  isServerToolFollowupErrorCode,
  normalizeCodeKey,
  readString,
  truncateReason
} from './executor/request-executor-error-shared.js';
import {
  cloneErrorForReporting,
  logNonBlockingError as logRequestExecutorNonBlockingError,
  resetErrorReportStateForTests
} from './executor/request-executor-error-report.js';
import {
  throwIfClientAbortSignalAborted,
  waitWithClientAbortSignal
} from './executor/request-executor-abort.js';
import {
  peekScopedErrorBackoffWaitMs,
  recordScopedErrorBackoff,
  resetScopedErrorBackoffByProvider,
  resetGlobalErrorBackoffStateForTests,
  waitScopedErrorBackoffWithGate
} from './executor/request-executor-global-error-backoff.js';
import {
  bodyContainsReasoningStopFinalizedMarker,
  detectAssistantSanitizationPlaceholder,
  detectEmptyProviderRequestPayload,
  detectRetryableEmptyAssistantResponse,
  persistPayloadContractProviderSnapshots
} from './executor/request-executor-response-contract.js';
import { processProviderResolveFailure } from './executor/request-executor-provider-resolve-failure.js';
import { resolveRequestExecutorPipelineAttempt } from './executor/request-executor-pipeline-attempt.js';
import {
  buildProviderExecutionSuccessResult,
  processSuccessfulProviderResponse
} from './executor/request-executor-provider-response.js';
import { processProviderSendFailure } from './executor/request-executor-provider-send-failure.js';
import {
  isHealthNeutralProviderError,
  reportRequestExecutorProviderError,
  resolveReportedProviderErrorRecoverable,
  resolveRequestExecutorProviderErrorClassification,
  resolveRequestExecutorProviderErrorReportPlan,
  shouldApplyProviderTransportBackoff
} from './executor/request-executor-provider-failure.js';
import { buildProviderRetryTelemetryPlan } from './executor/request-executor-retry-telemetry.js';
import {
  acquireRecoverableRetryWaiterSlotForTests,
  isLastAvailableProvider429,
  buildProviderTransportBackoffKey,
  buildRecoverableErrorBackoffKey,
  clearRecoverableErrorBackoff,
  clearRecoverableErrorBackoffForProvider,
  clearSessionStormBackoff,
  clearProviderTransportBackoff,
  consumeLogicalChainRecoverableRetry,
  consumeProviderScopedRetryBackoffMs,
  consumeProviderTransportBackoffMs,
  consumeRecoverableErrorBackoffMs,
  deriveLogicalRequestChainKey,
  buildSessionStormHardBlockError,
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffConsecutiveForTests,
  peekProviderTransportBackoffWaitMs,
  peekRecoverableRetryWaitersForTests,
  peekSessionStormBackoffWaitMs,
  releaseLogicalRequestChain,
  releaseRecoverableRetryWaiterSlotForTests,
  retainLogicalRequestChain,
  resetRequestExecutorRetryPlannerState,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExecutionPlan,
  resolveProviderRetryExclusionPlan,
  resolveSessionStormBackoffScope,
  resolveSessionStormBackoffScopes,
  sessionStormBackoffGateState,
  waitProviderTransportBackoffWithGate,
  waitRecoverableBackoffWithGlobalGate,
  waitSessionStormBackoffWithGate
} from './executor/request-executor-retry-planner.js';
import type {
  BlockingRecoverableRouteHoldState,
  ProviderRetryExecutionPlan,
  ProviderRetryTelemetryPlan,
  RequestExecutorProviderFailurePlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './executor/request-executor-error-types.js';
import {
  type HubDecodeBreakdown,
  type HubStageTopEntry,
  type RetryPayloadSeed,
  extractRetryErrorSnapshot,
  prepareRequestPayloadRetrySeed,
  readHubStageTop,
  readHubDecodeBreakdown,
  resolveOriginalRequestForResponseConversion,
  restoreRequestPayloadFromRetrySeed,
  setRetrySnapshotLogger
} from './executor/retry-payload-snapshot.js';
import {
  isServerToolFollowupRequest,
  logProviderRetrySwitchCompact,
  releaseProviderTrafficPermit,
  resolveStoplessLogState,
  type StoplessLogMode
} from './executor/request-executor-runtime-blocks.js';
import {
  createNoopProviderTrafficGovernor,
  getSharedProviderTrafficGovernor,
  type ProviderTrafficGovernorLike,
  type ProviderTrafficPermit
} from './provider-traffic-governor.js';
import {
  emitRequestExecutorVirtualRouterConcurrencyLog,
  createRequestExecutorPayloadContractErrorsampleWriter,
  resolveRequestExecutorTrafficRuntimeProfile,
  shouldBypassProviderResponseConversion
} from './executor/request-executor-runtime-blocks.js';
import {
  backfillResponsesOutputTextIfMissing
} from './executor/request-executor-response-text.js';
import {
  hasNonEmptyToolCalls,
  hasOutputFunctionCalls
} from './executor/request-executor-response-inspect.js';
export type RequestExecutorDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  getHubPipeline(routingPolicyGroup?: string): HubPipeline | null;
  getModuleDependencies(): ModuleDependencies;
  executeNestedInput?: (input: PipelineExecutionInput) => Promise<PipelineExecutionResult>;
  logStage(stage: string, requestId: string, details?: Record<string, unknown>): void;
  shouldLogStageEvent?(stage: string): boolean;
  stats: StatsManager;
  trafficGovernor?: ProviderTrafficGovernorLike;
  onRequestStart?: (args: { requestId: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  onRequestEnd?: (args: { requestId: string }) => void | Promise<void>;
};

export interface RequestExecutor {
  execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
}




const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
const RECOVERABLE_BACKOFF_TTL_MS = 5 * 60_000;
const recoverableErrorBackoffState = new Map<string, { consecutive: number; updatedAtMs: number }>();
const recoverableRetryGateState = new Map<string, Promise<void>>();
const recoverableRetryWaiterState = new Map<string, { activeWaiters: number; updatedAtMs: number }>();
const providerTransportBackoffState = new Map<string, {
  consecutive: number;
  updatedAtMs: number;
  nextAllowedAtMs: number;
}>();
const providerTransportBackoffGateState = new Map<string, Promise<void>>();
const logicalChainRetryState = new Map<string, {
  recoverableRetries: number;
  updatedAtMs: number;
  activeExecutions: number;
}>();

const PROVIDER_SWITCH_LOG_THROTTLE_MS = 5_000;
const providerSwitchLogState = new Map<string, { lastAtMs: number; suppressed: number }>();
const MAX_CONTEXT_OVERFLOW_RETRIES = 3;
// Re-export for backward compatibility
export type { SseWrapperErrorInfo };
function resetRequestExecutorInternalStateForTests(): void {
  resetErrorReportStateForTests();
  resetRequestExecutorRetryPlannerState();
  resetGlobalErrorBackoffStateForTests();
  providerSwitchLogState.clear();
}

export class HubRequestExecutor implements RequestExecutor {
  private readonly trafficGovernor: ProviderTrafficGovernorLike;

  constructor(private readonly deps: RequestExecutorDeps) {
    if (deps.trafficGovernor) {
      this.trafficGovernor = deps.trafficGovernor;
      this.installTrafficGovernorConcurrencyCallback();
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      this.trafficGovernor = createNoopProviderTrafficGovernor();
      return;
    }
    const disableTrafficGovernor =
      process.env.ROUTECODEX_PROVIDER_TRAFFIC_NOOP === '1'
      || process.env.RCC_PROVIDER_TRAFFIC_NOOP === '1';
    if (disableTrafficGovernor) {
      this.trafficGovernor = createNoopProviderTrafficGovernor();
      return;
    }
    this.trafficGovernor = getSharedProviderTrafficGovernor();
    this.installTrafficGovernorConcurrencyCallback();
  }

  private installTrafficGovernorConcurrencyCallback(): void {
    this.trafficGovernor.setConcurrencyBusyCallback?.((scopeKey, busy) => {
      try {
        const vr = this.deps.getHubPipeline()?.getVirtualRouter?.();
        if (vr) {
          if (typeof scopeKey !== 'string' || !scopeKey.trim()) {
            return;
          }
          if (busy) vr.markConcurrencyScopeBusy(scopeKey);
          else vr.markConcurrencyScopeIdle(scopeKey);
        }
      } catch { /* non-blocking */ }
    });
  }

  private shouldReenterFromSourceRequest(metadata: Record<string, unknown> | undefined): boolean {
    if (!this.deps.executeNestedInput) {
      return false;
    }
    const excludedProviderKeys =
      Array.isArray(metadata?.excludedProviderKeys)
        ? metadata.excludedProviderKeys.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
    if (excludedProviderKeys.length > 0) {
      return false;
    }
    const rt =
      metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
        ? (metadata.__rt as Record<string, unknown>)
        : undefined;
    const depth =
      typeof rt?.requestExecutorSourceReentryDepth === 'number'
      && Number.isFinite(rt.requestExecutorSourceReentryDepth)
        ? Math.max(0, Math.floor(rt.requestExecutorSourceReentryDepth))
        : 0;
    return depth < 1;
  }

  private async reenterFromSourceRequest(args: {
    input: PipelineExecutionInput;
    retryPayloadSeed: RetryPayloadSeed;
    metadataForAttempt: Record<string, unknown>;
    excludedProviderKeys: Set<string>;
  }): Promise<PipelineExecutionResult> {
    const restoredBody =
      restoreRequestPayloadFromRetrySeed(args.retryPayloadSeed)
      ?? (args.input.body && typeof args.input.body === 'object' ? args.input.body : {});
    const metadataRt =
      args.metadataForAttempt.__rt
      && typeof args.metadataForAttempt.__rt === 'object'
      && !Array.isArray(args.metadataForAttempt.__rt)
        ? (args.metadataForAttempt.__rt as Record<string, unknown>)
        : {};
    const currentDepth =
      typeof metadataRt.requestExecutorSourceReentryDepth === 'number'
      && Number.isFinite(metadataRt.requestExecutorSourceReentryDepth)
        ? Math.max(0, Math.floor(metadataRt.requestExecutorSourceReentryDepth))
        : 0;
    const nestedInput: PipelineExecutionInput = {
      ...args.input,
      body: restoredBody,
      metadata: {
        ...args.metadataForAttempt,
        excludedProviderKeys: Array.from(args.excludedProviderKeys),
        __rt: {
          ...metadataRt,
          requestExecutorSourceReentryDepth: currentDepth + 1
        }
      }
    };
    return await this.deps.executeNestedInput!(nestedInput);
  }

  private logProviderRetrySwitch(args: {
    requestId: string;
    attempt: number;
    maxAttempts: number;
    providerKey?: string;
    nextAttempt: number;
    reason: string;
    backoffMs?: number;
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    upstreamStatus?: number;
    switchAction: 'exclude_and_reroute' | 'retry_same_provider';
    backoffScope?: 'provider' | 'recoverable' | 'attempt';
    decisionLabel?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  }): void {
    logProviderRetrySwitchCompact({
      ...args,
      providerSwitchLogState,
      throttleMs: PROVIDER_SWITCH_LOG_THROTTLE_MS
    });
  }

  async execute(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    // Stats must remain stable across provider retries and requestId enhancements.
    const statsRequestId = input.requestId;
    const executorRequestId = input.requestId;
    const logicalRequestChainKey = retainLogicalRequestChain(deriveLogicalRequestChainKey(executorRequestId));
    let logicalRequestChainReleased = false;
    const releaseLogicalRequestChainIfNeeded = () => {
      if (logicalRequestChainReleased) {
        return;
      }
      logicalRequestChainReleased = true;
      releaseLogicalRequestChain(logicalRequestChainKey);
    };
    this.deps.stats.recordRequestStart(statsRequestId);
    const requestStartedAt = Date.now();
    const logStage = (stage: string, requestId: string, details?: Record<string, unknown>): void => {
      this.deps.logStage(stage, requestId, details);
    };
    const shouldLogStageEvent = (stage: string): boolean =>
      typeof this.deps.shouldLogStageEvent === 'function'
        ? this.deps.shouldLogStageEvent(stage)
        : true;
    const logStageLazy = (
      stage: string,
      requestId: string,
      detailsFactory: () => Record<string, unknown>
    ): void => {
      if (!shouldLogStageEvent(stage)) {
        return;
      }
      logStage(stage, requestId, detailsFactory());
    };
    const queuePayloadContractErrorsample =
      createRequestExecutorPayloadContractErrorsampleWriter(logRequestExecutorNonBlockingError);
    let recordedAnyAttempt = false;
    const recordAttempt = (options?: { usage?: UsageMetrics; error?: boolean }) => {
      this.deps.stats.recordCompletion(statsRequestId, options);
      recordedAnyAttempt = true;
    };
    const metadataRecord = asFlatRecord(input.metadata);
    const portScope =
      readString(metadataRecord?.routecodexRoutingPolicyGroup)
      || readString(metadataRecord?.routecodexPort)
      || 'unknown-port';
    const buildScopedBackoffKey = (providerKey: string, errorCode: string): string =>
      `${portScope}|${providerKey || 'unknown-provider'}|${errorCode || 'unknown-error'}`;
    const resolveScopedBackoffErrorCode = (error: unknown): string => {
      const record = asFlatRecord(error);
      const code =
        readString(record?.code)
        || readString(record?.upstreamCode)
        || (typeof extractStatusCodeFromError(error) === 'number' ? `status_${extractStatusCodeFromError(error)}` : '');
      return normalizeCodeKey(code || 'unknown_error') || 'unknown_error';
    };
    try {
      const hubPipeline = ensureHubPipeline(() => this.deps.getHubPipeline(readString(metadataRecord?.routecodexRoutingPolicyGroup)));
      const {
        initialMetadata,
        inboundClientHeaders,
        providerRequestId,
        clientRequestId,
        sessionStormBackoffScopes
      } = await initializeRequestExecutorRequestState({
        input,
        logStage,
        onRequestStart: this.deps.onRequestStart,
        logNonBlockingError: logRequestExecutorNonBlockingError
      });
      try {
        const pipelineLabel = 'hub';
        let aggregatedUsage: UsageMetrics | undefined;
        const excludedProviderKeys = new Set<string>();
        const maxAttempts = resolveMaxProviderAttempts();
        const retryPayloadSeed = prepareRequestPayloadRetrySeed(input.body);
        let attempt = 0;
        let allowBlockingRecoverableRetryBeyondAttemptBudget = false;
        let lastError: unknown;
        let initialRoutePool: string[] | null = null;
        let poolCooldownWaitBudgetMs = 60 * 1000;
        let blockingSingletonRecoverablePoolCooldown = false;
        let forcedRouteHint: string | undefined;
        let contextOverflowRetries = 0;
        let blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null = null;
        let cumulativeExternalLatencyMs = 0;
        let cumulativeTrafficWaitMs = 0;
        let cumulativeClientInjectWaitMs = 0;

        while (attempt < maxAttempts || allowBlockingRecoverableRetryBeyondAttemptBudget) {
        attempt += 1;
        allowBlockingRecoverableRetryBeyondAttemptBudget = false;
        const {
          metadataForAttempt,
          clientAbortSignal,
          clientHeadersForAttempt
        } = prepareRequestExecutorAttemptState({
          input,
          providerRequestId,
          retryPayloadSeed,
          attempt,
          initialMetadata,
          excludedProviderKeys,
          inboundClientHeaders,
          clientRequestId,
          forcedRouteHint,
          throwIfClientAbortSignalAborted
        });
        const hubStartedAtMs = Date.now();
        logStageLazy(`${pipelineLabel}.start`, providerRequestId, () => ({
          endpoint: input.entryEndpoint,
          stream: metadataForAttempt.stream,
          attempt
        }));
        let pipelineResult: Awaited<ReturnType<typeof runHubPipeline>>;
        try {
          pipelineResult = await runHubPipeline(hubPipeline, input, metadataForAttempt);
        } catch (pipelineError) {
          if (isPoolExhaustedPipelineError(pipelineError)) {
            const cooldownWaitMs = resolvePoolCooldownWaitMs(pipelineError);
            const candidateProviderCount = resolvePoolCooldownCandidateProviderCount(pipelineError);
            const singletonRecoverablePoolCandidate =
              cooldownWaitMs !== undefined && candidateProviderCount === 1;
            if (
              blockingRecoverableRouteHoldState?.holdOnLastAvailable429
              && blockingRecoverableRouteHoldState.explicitSingletonPool
            ) {
              const blockingRetryBackoffMs =
                cooldownWaitMs
                ?? consumeRecoverableErrorBackoffMs(
                  buildRecoverableErrorBackoffKey({
                    providerKey: blockingRecoverableRouteHoldState.providerKey,
                    runtimeKey: blockingRecoverableRouteHoldState.runtimeKey,
                    statusCode: blockingRecoverableRouteHoldState.retryError.statusCode,
                    errorCode: blockingRecoverableRouteHoldState.retryError.errorCode,
                    upstreamCode: blockingRecoverableRouteHoldState.retryError.upstreamCode,
                    reason: blockingRecoverableRouteHoldState.retryError.reason
                  }),
                  {
                    statusCode: blockingRecoverableRouteHoldState.retryError.statusCode,
                    errorCode: blockingRecoverableRouteHoldState.retryError.errorCode,
                    upstreamCode: blockingRecoverableRouteHoldState.retryError.upstreamCode,
                    reason: blockingRecoverableRouteHoldState.retryError.reason
                  }
                );
              logStage('provider.route_pool_cooldown_wait', providerRequestId, {
                attempt,
                waitMs: blockingRetryBackoffMs,
                holdOnLastAvailable429: true,
                reason: 'last_available_provider_429'
              });
              await waitWithClientAbortSignal(
                blockingRetryBackoffMs,
                clientAbortSignal,
                logRequestExecutorNonBlockingError
              );
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (singletonRecoverablePoolCandidate) {
              blockingSingletonRecoverablePoolCooldown = true;
              logStage('provider.route_pool_cooldown_wait', providerRequestId, {
                attempt,
                waitMs: cooldownWaitMs,
                reason: 'single_provider_pool_recoverable'
              });
              await waitWithClientAbortSignal(
                cooldownWaitMs,
                clientAbortSignal,
                logRequestExecutorNonBlockingError
              );
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (
              cooldownWaitMs &&
              attempt < maxAttempts &&
              poolCooldownWaitBudgetMs >= cooldownWaitMs
            ) {
              logStage(`${pipelineLabel}.completed`, providerRequestId, {
                route: undefined,
                target: undefined,
                elapsedMs: Date.now() - hubStartedAtMs,
                attempt,
                recoverablePoolCooldown: true
              });
              logStage('provider.route_pool_cooldown_wait', providerRequestId, {
                attempt,
                waitMs: cooldownWaitMs,
                waitBudgetMs: poolCooldownWaitBudgetMs,
                reason: 'provider_pool_cooling_down'
              });
              poolCooldownWaitBudgetMs -= cooldownWaitMs;
              await waitWithClientAbortSignal(
                cooldownWaitMs,
                clientAbortSignal,
                logRequestExecutorNonBlockingError
              );
              attempt = Math.max(0, attempt - 1);
              continue;
            }
            if (blockingSingletonRecoverablePoolCooldown && lastError) {
              throw lastError;
            }
            if (lastError) {
              throw lastError;
            }
          }
          throw pipelineError;
        }
        blockingSingletonRecoverablePoolCooldown = false;
        const resolvedPipelineAttempt = resolveRequestExecutorPipelineAttempt({
          inputRequestId: input.requestId,
          providerRequestId,
          attempt,
          metadataForAttempt,
          pipelineResult,
          clientHeadersForAttempt,
          clientRequestId,
          clientAbortSignal,
          initialRoutePool,
          excludedProviderKeys,
          lastError,
          blockingRecoverableRouteHoldState,
          throwIfClientAbortSignalAborted,
          logStage: (stage, requestId, details) => logStage(stage, requestId, details),
          extractRetryErrorSnapshot,
          hubStartedAtMs,
          pipelineLabel
        });
        if (resolvedPipelineAttempt.kind === 'retry_next_attempt') {
          initialRoutePool = resolvedPipelineAttempt.initialRoutePool;
          continue;
        }
        blockingRecoverableRouteHoldState = null;
        initialRoutePool = resolvedPipelineAttempt.initialRoutePool;
        const {
          mergedMetadata,
          routePoolForAttempt,
          providerPayload,
          target
        } = resolvedPipelineAttempt;
        const concurrencyScopeKey =
          typeof target.concurrencyScopeKey === 'string' && target.concurrencyScopeKey.trim()
            ? target.concurrencyScopeKey.trim()
            : undefined;

        let runtimeKey: string = typeof target.runtimeKey === 'string' ? target.runtimeKey : '';
        let handle: ProviderHandle;
        let providerContext: ReturnType<typeof resolveProviderRequestContext>;
        try {
          logStageLazy('provider.runtime_resolve.start', providerRequestId, () => ({
            providerKey: target.providerKey,
            route: pipelineResult.routingDecision?.routeName,
            attempt
          }));
          const resolved = await resolveProviderRuntimeOrThrow({
            requestId: input.requestId,
            target: {
              providerKey: target.providerKey,
              outboundProfile: String((target as any).outboundProfile || ''),
              providerType: String((target as any).providerType || '')
            },
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKeyHint: target.runtimeKey,
            runtimeManager: this.deps.runtimeManager,
            dependencies: this.deps.getModuleDependencies()
          });
          runtimeKey = resolved.runtimeKey;
          handle = resolved.handle;
          logStage('provider.runtime_resolve.completed', providerRequestId, {
            runtimeKey,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            attempt
          });

          logStageLazy('provider.context_resolve.start', providerRequestId, () => ({
            providerKey: target.providerKey,
            runtimeKey,
            attempt
          }));
          providerContext = resolveProviderRequestContext({
            providerRequestId,
            entryEndpoint: input.entryEndpoint,
            target: {
              providerKey: target.providerKey,
              outboundProfile: target.outboundProfile as ProviderProtocol
            },
            handle,
            runtimeKey,
            providerPayload,
            mergedMetadata
          });
        } catch (error) {
          const resolveFailure = await processProviderResolveFailure({
            error,
            requestId: providerRequestId,
            providerKey: target.providerKey,
            providerType:
              typeof (target as { providerType?: unknown }).providerType === 'string'
                ? String((target as { providerType?: string }).providerType)
                : undefined,
            providerProtocol: target.outboundProfile as ProviderProtocol,
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKey,
            target: target as unknown as Record<string, unknown>,
            dependencies: this.deps.getModuleDependencies(),
            attempt,
            maxAttempts,
            logicalRequestChainKey,
            routePoolForAttempt,
            excludedProviderKeys,
            recordAttempt,
            logStage: (stage, requestId, details) => logStage(stage, requestId, details),
            logProviderRetrySwitch: (switchArgs) => this.logProviderRetrySwitch(switchArgs),
            forcedRouteHint,
            abortSignal: clientAbortSignal,
            logNonBlockingError: logRequestExecutorNonBlockingError,
            extractRetryErrorSnapshot
          });
          const failureState = applyResolveFailureState({
            lastError,
            blockingRecoverableRouteHoldState,
            allowBlockingRecoverableRetryBeyondAttemptBudget,
            forcedRouteHint,
            contextOverflowRetries,
            cumulativeExternalLatencyMs
          } satisfies RequestExecutorFailureState, resolveFailure);
          lastError = failureState.lastError;
          blockingRecoverableRouteHoldState = failureState.blockingRecoverableRouteHoldState;
          allowBlockingRecoverableRetryBeyondAttemptBudget =
            failureState.allowBlockingRecoverableRetryBeyondAttemptBudget;
          if (this.shouldReenterFromSourceRequest(metadataForAttempt)) {
            return await this.reenterFromSourceRequest({
              input,
              retryPayloadSeed,
              metadataForAttempt,
              excludedProviderKeys
            });
          }
          continue;
        }
        const previousRequestId = input.requestId;
        if (providerContext.requestId !== input.requestId) {
          input.requestId = providerContext.requestId;
          try {
            await rebindResponsesConversationRequestId(previousRequestId, input.requestId);
          } catch (error) {
            logStage('responsesConversation.rebindRequestId.error', input.requestId, {
              previousRequestId,
              providerKey: target.providerKey,
              runtimeKey,
              message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
              attempt
            });
            throw error;
          }
        }
        logStage('provider.context_resolve.completed', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          providerProtocol: providerContext.providerProtocol,
          model: providerContext.providerModel,
          requestIdChanged: previousRequestId !== input.requestId,
          previousRequestId,
          requestId: input.requestId,
          attempt
        });
        registerRequestLogContext(providerContext.requestId, {
          sessionId: mergedMetadata.sessionId,
          conversationId: mergedMetadata.conversationId
        });
        const { providerProtocol, providerModel, providerLabel } = providerContext;
        if (clientHeadersForAttempt) {
          ensureClientHeadersOnPayload(providerPayload, clientHeadersForAttempt);
        }
        this.deps.stats.bindProvider(statsRequestId, {
          providerKey: target.providerKey,
          providerType: handle.providerType,
          model: providerModel
        });

        logStageLazy('provider.prepare', input.requestId, () => ({
          providerKey: target.providerKey,
          runtimeKey,
          protocol: providerProtocol,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel,
          attempt
        }));
        throwIfClientAbortSignalAborted(clientAbortSignal);

        logStageLazy('provider.metadata_attach.start', input.requestId, () => ({
          providerKey: target.providerKey,
          runtimeKey,
          attempt
        }));
        attachProviderRuntimeMetadata(providerPayload, {
          requestId: input.requestId,
          providerId: handle.providerId,
          providerKey: target.providerKey,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          providerProtocol,
          pipelineId: target.providerKey,
          routeName: pipelineResult.routingDecision?.routeName,
          runtimeKey,
          target,
          metadata: mergedMetadata,
          compatibilityProfile: target.compatibilityProfile,
          abortSignal: getClientConnectionAbortSignal(mergedMetadata)
        });
        logStage('provider.metadata_attach.completed', input.requestId, {
          providerKey: target.providerKey,
          runtimeKey,
          attempt
        });
        const emptyProviderRequestSignal = detectEmptyProviderRequestPayload(providerPayload);
        if (emptyProviderRequestSignal) {
          queuePayloadContractErrorsample({
            phase: 'provider-request',
            requestId: input.requestId,
            entryEndpoint: input.entryEndpoint,
            providerKey: target.providerKey,
            providerId: handle.providerId,
            marker: emptyProviderRequestSignal.marker,
            reason: emptyProviderRequestSignal.reason,
            observation: {
              providerPayload
            }
          });
          logStage('host.request_contract.empty_provider_payload', input.requestId, {
            providerKey: target.providerKey,
            marker: emptyProviderRequestSignal.marker,
            reason: emptyProviderRequestSignal.reason,
            attempt
          });
        }
        const providerTransportBackoffKey = buildProviderTransportBackoffKey({
          providerKey: target.providerKey,
          runtimeKey
        });

        let trafficPermit: ProviderTrafficPermit | null = null;
        let trafficPolicyMaxInFlight = 0;
        let trafficActiveInFlightAtAcquire = 0;
        let providerSendStartedAtMs = 0;
        let providerSendElapsedMs = 0;
        const stoplessLogState = resolveStoplessLogState(mergedMetadata);
        const providerRequestedStream =
          typeof (providerPayload as { stream?: unknown } | undefined)?.stream === 'boolean'
            ? Boolean((providerPayload as { stream?: unknown }).stream)
            : undefined;
        const bypassTrafficGovernor = isServerToolFollowupRequest(metadataForAttempt);
        try {
          throwIfClientAbortSignalAborted(clientAbortSignal);
          if (providerTransportBackoffKey) {
            const pendingProviderTransportWaitMs = peekProviderTransportBackoffWaitMs(providerTransportBackoffKey);
            if (pendingProviderTransportWaitMs > 0) {
              logStage('provider.transport_backoff_wait', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                waitMs: pendingProviderTransportWaitMs,
                attempt
              });
              await waitProviderTransportBackoffWithGate({
                key: providerTransportBackoffKey,
                ms: pendingProviderTransportWaitMs,
                signal: clientAbortSignal,
                logNonBlockingError: logRequestExecutorNonBlockingError
              });
              logStage('provider.transport_backoff_wait.completed', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                waitMs: pendingProviderTransportWaitMs,
                attempt
              });
            }
          }
          if (bypassTrafficGovernor) {
            logStage('provider.traffic.acquire.bypassed', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              reason: 'servertool_followup',
              attempt
            });
          } else {
            logStage('provider.traffic.acquire.start', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              attempt
            });
            const trafficRuntimeProfile = resolveRequestExecutorTrafficRuntimeProfile(runtimeKey, handle, target.providerKey);
            const trafficAcquired = await this.trafficGovernor.acquire({
              runtimeKey,
              providerKey: target.providerKey,
              requestId: input.requestId,
              runtime: trafficRuntimeProfile,
              softWaitTimeoutMs: resolveProviderTrafficSoftWaitTimeoutMs({
                runtimeKey,
                handle,
                providerKey: target.providerKey,
                compatibilityProfile: target.compatibilityProfile
              })
            });
            trafficPermit = trafficAcquired.permit;
            trafficPolicyMaxInFlight = trafficAcquired.policy.concurrency.maxInFlight;
            trafficActiveInFlightAtAcquire = trafficAcquired.activeInFlight;
            if (trafficAcquired.waitedMs > 0) {
              cumulativeTrafficWaitMs += trafficAcquired.waitedMs;
              logStage('provider.traffic.acquire.wait', input.requestId, {
                providerKey: target.providerKey,
                runtimeKey,
                waitedMs: trafficAcquired.waitedMs,
                attempt
              });
            }
            logStage('provider.traffic.acquire.completed', input.requestId, {
              providerKey: target.providerKey,
              runtimeKey,
              concurrencyScopeKey,
              maxInFlight: trafficAcquired.policy.concurrency.maxInFlight,
              requestsPerMinute: trafficAcquired.policy.rpm.requestsPerMinute,
              activeInFlight: trafficAcquired.activeInFlight,
              rpmInWindow: trafficAcquired.rpmInWindow,
              attempt
            });
          }
          const routingDecisionRecord =
            pipelineResult.routingDecision && typeof pipelineResult.routingDecision === 'object'
              ? (pipelineResult.routingDecision as Record<string, unknown>)
              : undefined;

          emitRequestExecutorVirtualRouterConcurrencyLog({
            sessionId: readString(mergedMetadata.sessionId) ?? readString(mergedMetadata.conversationId),
            projectPath:
              readString(mergedMetadata.clientWorkdir)
              ?? readString(mergedMetadata.client_workdir)
              ?? readString(mergedMetadata.workdir)
              ?? readString(mergedMetadata.cwd),
            routeName: pipelineResult.routingDecision?.routeName,
            poolId: readString(routingDecisionRecord?.poolId),
            providerKey: target.providerKey,
            model: providerModel,
            reason: readString(routingDecisionRecord?.reasoning),
            stoplessMode: stoplessLogState.mode,
            stoplessArmed: stoplessLogState.armed,
            activeInFlight: trafficActiveInFlightAtAcquire,
            maxInFlight: trafficPolicyMaxInFlight
          });

          providerSendStartedAtMs = Date.now();
          logStageLazy('provider.send.start', input.requestId, () => ({
            providerKey: target.providerKey,
            runtimeKey,
            protocol: providerProtocol,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            providerRequestedStream,
            attempt
          }));
          throwIfClientAbortSignalAborted(clientAbortSignal);

          allowSnapshotLocalDiskWrite(
            executorRequestId,
            providerRequestId,
            input.requestId,
            clientRequestId
          );
          const providerResponse = await handle.instance.processIncoming(providerPayload);
          const responseStatus = extractResponseStatus(providerResponse);
          providerSendElapsedMs = Date.now() - providerSendStartedAtMs;
          cumulativeExternalLatencyMs += providerSendElapsedMs;
          logStage('provider.send.completed', input.requestId, {
            providerKey: target.providerKey,
            status: responseStatus,
            elapsedMs: providerSendElapsedMs,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            model: providerModel,
            providerLabel,
            attempt
          });
          const wantsStreamBase = Boolean(input.metadata?.inboundStream ?? input.metadata?.stream);
          logStageLazy('provider.response_normalize.start', input.requestId, () => ({
            providerKey: target.providerKey,
            attempt
          }));
          const normalized = normalizeProviderResponse(providerResponse);
          logStage('provider.response_normalize.completed', input.requestId, {
            providerKey: target.providerKey,
            status: normalized.status,
            attempt
          });
          logStageLazy('provider.usage_extract.start', input.requestId, () => ({
            providerKey: target.providerKey,
            source: 'provider_response',
            attempt
          }));
          const usageFromProvider = extractUsageFromResult(normalized, {
            ...mergedMetadata,
            providerProtocol,
            providerType: handle.providerType,
            providerKey: target.providerKey
          });
          logStage('provider.usage_extract.completed', input.requestId, {
            providerKey: target.providerKey,
            source: 'provider_response',
            hasUsage: Boolean(usageFromProvider),
            attempt
          });
          logStageLazy('provider.request_semantics.start', input.requestId, () => ({
            providerKey: target.providerKey,
            attempt
          }));
          const requestSemantics = resolveRequestSemantics(
            pipelineResult.processedRequest as Record<string, unknown> | undefined,
            pipelineResult.standardizedRequest as Record<string, unknown> | undefined,
            mergedMetadata
          );
          if (
            typeof target.providerKey === 'string'
            && target.providerKey.startsWith('deepseek-web.')
            && input.entryEndpoint?.includes('/v1/responses')
          ) {
            const semanticsTrace = describeRequestSemanticsResolution(
              pipelineResult.processedRequest as Record<string, unknown> | undefined,
              pipelineResult.standardizedRequest as Record<string, unknown> | undefined,
              mergedMetadata,
              requestSemantics
            );
            logStage('provider.request_semantics.trace', input.requestId, {
              providerKey: target.providerKey,
              attempt,
              ...semanticsTrace,
              hasRequestedToolsInSemantics: hasRequestedToolsInSemantics(requestSemantics),
              isToolResultFollowupTurn: isToolResultFollowupTurn(requestSemantics)
            });
          }
          logStage('provider.request_semantics.completed', input.requestId, {
            providerKey: target.providerKey,
            hasSemantics: Boolean(requestSemantics && Object.keys(requestSemantics).length),
            attempt
          });
          const serverToolsEnabled = isServerToolEnabled();
          logStageLazy('provider.response_convert.start', input.requestId, () => ({
            providerKey: target.providerKey,
            protocol: providerProtocol,
            processMode: pipelineResult.processMode,
            wantsStream: wantsStreamBase,
            serverToolsEnabled,
            attempt
          }));
          const hubResponseStartedAtMs = Date.now();
          logStageLazy('hub.response.start', input.requestId, () => ({
            providerKey: target.providerKey,
            protocol: providerProtocol,
            processMode: pipelineResult.processMode,
            attempt
          }));
          const responseMetadata = normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
            ? (normalized.metadata as Record<string, unknown>)
            : undefined;
          const responseSemantics = responseMetadata?.responseSemantics && typeof responseMetadata.responseSemantics === 'object' && !Array.isArray(responseMetadata.responseSemantics)
            ? (responseMetadata.responseSemantics as Record<string, unknown>)
            : undefined;
          const conversionPipelineMetadata = responseSemantics
            ? {
                ...mergedMetadata,
                responseSemantics,
              }
            : mergedMetadata;
          const converted = shouldBypassProviderResponseConversion(normalized, {
            entryEndpoint: input.entryEndpoint,
            providerProtocol: handle.providerProtocol || providerProtocol,
            serverToolsEnabled,
            metadata: conversionPipelineMetadata
          })
            ? (() => {
              logStage('provider.response_convert.skipped', input.requestId, {
                providerKey: target.providerKey,
                status: normalized.status,
                reason: 'non_success_status_bypass',
                attempt
              });
              return normalized;
            })()
            : await this.convertProviderResponseIfNeeded({
              entryEndpoint: input.entryEndpoint,
              providerProtocol: handle.providerProtocol || providerProtocol,
              providerType: handle.providerType,
              providerFamily: handle.providerFamily,
              requestId: input.requestId,
              serverToolsEnabled,
              wantsStream: wantsStreamBase,
              originalRequest: resolveOriginalRequestForResponseConversion(retryPayloadSeed),
              requestSemantics,
              processMode: pipelineResult.processMode,
              response: normalized,
              pipelineMetadata: conversionPipelineMetadata
            });
          const clientInjectWaitMsRaw = converted.timingBreakdown?.hubResponseExcludedMs;
          const clientInjectWaitMs =
            typeof clientInjectWaitMsRaw === 'number' && Number.isFinite(clientInjectWaitMsRaw)
              ? Math.max(0, Math.floor(clientInjectWaitMsRaw))
              : 0;
          if (clientInjectWaitMs > 0) {
            cumulativeClientInjectWaitMs += clientInjectWaitMs;
          }
          const hubResponseElapsedMsRaw = Date.now() - hubResponseStartedAtMs;
          const hubResponseElapsedMs = Math.max(0, hubResponseElapsedMsRaw - clientInjectWaitMs);
          const convertedBodyRecord =
            converted.body && typeof converted.body === 'object'
              ? (converted.body as Record<string, unknown>)
              : undefined;
          const convertedStatusCode = typeof converted.status === 'number' ? converted.status : 0;
          if (convertedStatusCode >= 400) {
            await clearResponsesConversationByRequestId(input.requestId || executorRequestId).catch(() => {
              // non-blocking cleanup
            });
          }
          const normalizedBodyRecord =
            normalized.body && typeof normalized.body === 'object'
              ? (normalized.body as Record<string, unknown>)
              : undefined;
          if (convertedBodyRecord) {
            backfillResponsesOutputTextIfMissing(convertedBodyRecord);
          }
          const finishReason = (() => {
            if (
              convertedBodyRecord
              && typeof convertedBodyRecord[STREAM_LOG_FINISH_REASON_KEY] === 'string'
            ) {
              return String(convertedBodyRecord[STREAM_LOG_FINISH_REASON_KEY]);
            }
            const fromConverted = deriveFinishReason(convertedBodyRecord);
            if (fromConverted) {
              return fromConverted;
            }
            return deriveFinishReason(normalizedBodyRecord);
          })();
          logStage('provider.response_convert.completed', input.requestId, {
            providerKey: target.providerKey,
            status: converted.status,
            hasBody: converted.body !== undefined && converted.body !== null,
            attempt
          });
          if (clientInjectWaitMs > 0) {
            logStage('client.inject_wait.start', input.requestId, {
              providerKey: target.providerKey,
              attempt
            });
            logStage('client.inject_wait.completed', input.requestId, {
              providerKey: target.providerKey,
              elapsedMs: clientInjectWaitMs,
              attempt
            });
          }
          logStage('hub.response.completed', input.requestId, {
            providerKey: target.providerKey,
            status: converted.status,
            elapsedMs: hubResponseElapsedMs,
            ...(clientInjectWaitMs > 0 ? { excludedClientInjectWaitMs: clientInjectWaitMs } : {}),
            hasBody: converted.body !== undefined && converted.body !== null,
            ...(finishReason ? { finishReason } : {}),
            attempt
          });
          const providerResponseResult = await processSuccessfulProviderResponse({
            inputRequestId: input.requestId,
            entryEndpoint: input.entryEndpoint,
            providerKey: target.providerKey,
            providerId: handle.providerId,
            providerModel,
            providerProtocol,
            providerPayload,
            normalized,
            converted,
            requestSemantics,
            mergedMetadata,
            bypassTrafficGovernor,
            trafficGovernor: this.trafficGovernor,
            runtimeKey,
            trafficActiveInFlightAtAcquire,
            trafficPolicyMaxInFlight,
            stats: this.deps.stats,
            aggregatedUsage,
            providerUsageFallback: usageFromProvider,
            attempt,
            logStage: (stage, requestId, details) => logStage(stage, requestId, details),
            logNonBlockingError: logRequestExecutorNonBlockingError,
            queuePayloadContractErrorsample,
            writeProviderSnapshot,
            clearProviderTransportBackoff: () => {
              clearProviderTransportBackoff(providerTransportBackoffKey);
              clearRecoverableErrorBackoffForProvider({ providerKey: target.providerKey, runtimeKey });
            }
          });
          aggregatedUsage = providerResponseResult.aggregatedUsage;

          // Responses continuation retention/cleanup must be decided after HTTP response shaping,
          // because response.id (submit anchor) is finalized there. Doing release/clear here can
          // race ahead of response-id indexing and break submit_tool_outputs restore across
          // direct/relay hops. Keep executor transport-only; handler owns responses store finalization.

          recordAttempt({ usage: aggregatedUsage, error: false });
          for (const scope of sessionStormBackoffScopes ?? []) {
            clearSessionStormBackoff(scope);
          }
          resetScopedErrorBackoffByProvider(`${portScope}|${target.providerKey}|`);
          return buildProviderExecutionSuccessResult({
            converted,
            providerKey: target.providerKey,
            providerModel,
            routeName: pipelineResult.routingDecision?.routeName,
            routingPoolId: readString(routingDecisionRecord?.poolId),
            finishReason,
            stoplessMode: stoplessLogState.mode,
            stoplessArmed: stoplessLogState.armed,
            aggregatedUsage: aggregatedUsage as Record<string, unknown> | undefined,
            cumulativeExternalLatencyMs,
            cumulativeTrafficWaitMs,
            cumulativeClientInjectWaitMs,
            attempt,
            requestStartedAtMs: requestStartedAt,
            providerRequestId,
            inputRequestId: input.requestId,
            mergedMetadata,
            readString,
            readHubStageTop,
            readHubDecodeBreakdown
          });
        } catch (error) {
          const sendFailure = await processProviderSendFailure({
            error,
            requestId: input.requestId,
            providerKey: target.providerKey,
            providerId: handle.providerId,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            providerProtocol,
            providerModel,
            providerLabel,
            routeName: pipelineResult.routingDecision?.routeName,
            runtimeKey,
            target: target as unknown as Record<string, unknown>,
            dependencies: this.deps.getModuleDependencies(),
            runtimeManager: this.deps.runtimeManager,
            attempt,
            maxAttempts,
            logicalRequestChainKey,
            routePoolForAttempt,
            excludedProviderKeys,
            recordAttempt,
            logStage: (stage, requestId, details) => logStage(stage, requestId, details),
            logProviderRetrySwitch: (switchArgs) => this.logProviderRetrySwitch(switchArgs),
            bypassTrafficGovernor,
            trafficGovernor: this.trafficGovernor,
            trafficActiveInFlightAtAcquire,
            trafficPolicyMaxInFlight,
            providerTransportBackoffKey,
            consumeProviderTransportBackoffMs,
            sessionStormBackoffScopes,
            isSessionStormBackoffCandidate,
            consumeSessionStormBackoffMs,
            getSessionStormBackoffConsecutive: peekSessionStormBackoffConsecutiveForTests,
            providerSendStartedAtMs,
            providerSendElapsedMs,
            cumulativeExternalLatencyMs,
            forcedRouteHint,
            contextOverflowRetries,
            maxContextOverflowRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
            abortSignal: clientAbortSignal,
            logNonBlockingError: logRequestExecutorNonBlockingError,
            extractRetryErrorSnapshot
          });
          const failureState = applySendFailureState({
            lastError,
            blockingRecoverableRouteHoldState,
            allowBlockingRecoverableRetryBeyondAttemptBudget,
            forcedRouteHint,
            contextOverflowRetries,
            cumulativeExternalLatencyMs
          } satisfies RequestExecutorFailureState, sendFailure);
          lastError = failureState.lastError ?? error;
          blockingRecoverableRouteHoldState = failureState.blockingRecoverableRouteHoldState;
          allowBlockingRecoverableRetryBeyondAttemptBudget =
            failureState.allowBlockingRecoverableRetryBeyondAttemptBudget;
          forcedRouteHint = failureState.forcedRouteHint;
          contextOverflowRetries = failureState.contextOverflowRetries;
          cumulativeExternalLatencyMs = failureState.cumulativeExternalLatencyMs;
          if (target.providerKey) {
            const scopedErrorCode = resolveScopedBackoffErrorCode(error);
            const scopedBackoffKey = buildScopedBackoffKey(target.providerKey, scopedErrorCode);
            const pendingScopedWaitMs = peekScopedErrorBackoffWaitMs(scopedBackoffKey);
            if (pendingScopedWaitMs > 0) {
              logStage('server.global_error_backoff_wait', providerRequestId, {
                waitMs: pendingScopedWaitMs,
                scope: scopedBackoffKey
              });
              await waitScopedErrorBackoffWithGate(scopedBackoffKey, getClientConnectionAbortSignal(input.metadata));
              logStage('server.global_error_backoff_wait.completed', providerRequestId, {
                waitMs: pendingScopedWaitMs,
                scope: scopedBackoffKey
              });
            }
            recordScopedErrorBackoff(scopedBackoffKey);
          }
          if (this.shouldReenterFromSourceRequest(metadataForAttempt)) {
            return await this.reenterFromSourceRequest({
              input,
              retryPayloadSeed,
              metadataForAttempt,
              excludedProviderKeys
            });
          }
          continue;
        } finally {
          if (trafficPermit) {
            await releaseProviderTrafficPermit({
              trafficPermit,
              trafficGovernor: this.trafficGovernor,
              requestId: input.requestId,
              providerKey: target.providerKey,
              runtimeKey,
              attempt,
              logStage: (stage, requestId, details) => logStage(stage, requestId, details)
            });
            trafficPermit = null;
          }
        }
        }

        throw lastError ?? new Error('Provider execution failed without response');
      } finally {
        await this.deps.onRequestEnd?.({ requestId: executorRequestId });
        releaseLogicalRequestChainIfNeeded();
      }
    } catch (error: unknown) {
      try {
        await clearResponsesConversationByRequestId(input.requestId || executorRequestId);
      } catch {
        // non-blocking cleanup
      }
      const scopedErrorCode = resolveScopedBackoffErrorCode(error);
      const scopedBackoffKey = buildScopedBackoffKey('unresolved-provider', scopedErrorCode);
      recordScopedErrorBackoff(scopedBackoffKey);
      // If we failed before selecting a provider (no bindProvider/recordAttempt),
      // at least record one error sample for this request.
      if (!recordedAnyAttempt) {
        recordAttempt({ error: true });
      }
      releaseLogicalRequestChainIfNeeded();
      throw error;
    }
  }
  private async convertProviderResponseIfNeeded(options: {
    entryEndpoint?: string;
    providerProtocol: string;
    providerType?: string;
    providerFamily?: string;
    requestId: string;
    serverToolsEnabled?: boolean;
    wantsStream: boolean;
    originalRequest?: Record<string, unknown>;
    requestSemantics?: Record<string, unknown>;
    processMode?: string;
    response: PipelineExecutionResult;
    pipelineMetadata?: Record<string, unknown>;
  }): Promise<PipelineExecutionResult> {
    return convertProviderResponseWithBridge(options, {
      runtimeManager: this.deps.runtimeManager,
      executeNested: (nestedInput) => (
        this.deps.executeNestedInput
          ? this.deps.executeNestedInput(nestedInput)
          : this.execute(nestedInput)
      )
    });
  }

}

export const __requestExecutorTestables = {
  readString,
  extractRetryErrorSnapshot,
  truncateReason,
  isHealthNeutralProviderError,
  isLastAvailableProvider429,
  shouldApplyProviderTransportBackoff,
  buildRecoverableErrorBackoffKey,
  clearRecoverableErrorBackoff,
  clearRecoverableErrorBackoffForProvider,
  consumeRecoverableErrorBackoffMs,
  buildProviderTransportBackoffKey,
  consumeProviderTransportBackoffMs,
  peekProviderTransportBackoffWaitMs,
  clearProviderTransportBackoff,
  hasRequestedToolsInSemantics,
  isRequiredToolCallTurn,
  isToolResultFollowupTurn,
  bodyContainsReasoningStopFinalizedMarker,
  detectRetryableEmptyAssistantResponse,
  deriveLogicalRequestChainKey,
  resolveSessionStormBackoffScope,
  resolveSessionStormBackoffScopes,
  isSessionStormBackoffCandidate,
  buildSessionStormHardBlockError,
  consumeSessionStormBackoffMs,
  peekSessionStormBackoffWaitMs,
  peekScopedErrorBackoffWaitMs,
  clearSessionStormBackoff,
  recordScopedErrorBackoff,
  resetScopedErrorBackoffByProvider,
  prepareRequestPayloadRetrySeed,
  resolveOriginalRequestForResponseConversion,
  resolveRequestExecutorProviderErrorClassification,
  resolveRequestExecutorProviderErrorReportPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExclusionPlan,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryExecutionPlan,
  resolveRequestExecutorPipelineAttempt,
  buildProviderRetryTelemetryPlan,
  acquireRecoverableRetryWaiterSlotForTests,
  peekRecoverableRetryWaitersForTests,
  releaseRecoverableRetryWaiterSlotForTests,
  resetRequestExecutorInternalStateForTests
};

export function createRequestExecutor(deps: RequestExecutorDeps): RequestExecutor {
  return new HubRequestExecutor(deps);
}
