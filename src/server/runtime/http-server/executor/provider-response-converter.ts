import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  isImagePathLike,
  containsBroadKillCommand
} from './provider-response-tool-validation-blocks.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
  persistStoplessGoalStateSnapshot,
  readStoplessGoalState
} from '../../../../modules/llmswitch/bridge.js';
import {
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  buildServerToolSseWrapperBody
} from './servertool-response-normalizer.js';
import {
  buildServerToolAdapterContext
} from './servertool-adapter-context.js';
import {
  executeServerToolClientInjectDispatch,
  executeServerToolReenterPipeline
} from './servertool-followup-dispatch.js';
import {
  compactFollowupLogReason,
  extractServerToolFollowupErrorLogDetails,
  finalizeServerToolBridgeConvertError
} from './servertool-followup-error.js';
import { requireCoreDist } from '../../../../modules/llmswitch/bridge.js';

import {
  asFlatRecord,
  hasStoplessDirectiveInRequestPayload,
  findNestedRawString,
  findNestedErrorMarker,
  normalizeRecoveredToolCalls,
  stringifyToolCallArgumentsForValidation,
  isGenericBridgeResponseContractError,
  isContextLengthExceededError,
  isRetryableNetworkSseWrapperError,
  extractBridgeProviderResponsePayload,
  TRUTHY_VALUES,
  FATAL_CONVERSION_ERROR_CODES,
  STOPLESS_DIRECTIVE_PATTERN
} from './provider-response-shared-pure-blocks.js';

type StoplessGoalProjection = {
  status: 'active' | 'paused' | 'stopped' | 'completed';
  objective: string;
  latestNote?: string;
  completionEvidence?: string;
  nextStep?: string;
  userQuestion?: string;
  cannotContinueReason?: string;
  blockingEvidence?: string;
  attemptsExhausted?: boolean;
  errorClass?: string;
  completionSummary?: string;
  ssotAssessment?: string;
  consecutiveIrrecoverableErrors?: number;
  consecutiveValidationFailures?: number;
  consecutiveNoProgress?: number;
  updatedAt: number;
  createdAt: number;
};

const GOAL_IRRECOVERABLE_ERROR_STOP_THRESHOLD = 5;
const GOAL_VALIDATION_FAILURE_STOP_THRESHOLD = 5;
const GOAL_NO_PROGRESS_STOP_THRESHOLD = 5;
const REPEATED_VALIDATION_FAILURE_ERROR_CLASS = 'repeated_validation_failure';
const REPEATED_IRRECOVERABLE_ERROR_CLASS = 'repeated_irrecoverable_error';
const REPEATED_NO_PROGRESS_STOP_ERROR_CLASS = 'repeated_no_progress_stop';

type NativeRespSemanticsModule = {
  normalizeResponsesToolCallArgumentsForClientWithNative?: (
    responsesPayload: unknown,
    toolsRaw: unknown[]
  ) => Record<string, unknown>;
};

function normalizeResponsesToolCallArgumentsForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[]
): Record<string, unknown> {
  const mod = requireCoreDist<NativeRespSemanticsModule>(
    'router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics'
  );
  const fn = mod.normalizeResponsesToolCallArgumentsForClientWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] normalizeResponsesToolCallArgumentsForClientWithNative not available');
  }
  return fn(responsesPayload, toolsRaw);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function normalizeGoalCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function buildHostForcedStoppedGoalState(args: {
  currentGoal: StoplessGoalProjection;
  errorClass: string;
  blockingEvidence: string;
  counterField: 'consecutiveIrrecoverableErrors' | 'consecutiveValidationFailures' | 'consecutiveNoProgress';
  counterValue: number;
}): StoplessGoalProjection {
  const nowMs = Date.now();
  return {
    status: 'stopped',
    objective: args.currentGoal.objective,
    blockingEvidence: args.blockingEvidence,
    latestNote: args.blockingEvidence,
    attemptsExhausted: true,
    errorClass: args.errorClass,
    updatedAt: nowMs,
    createdAt:
      readFiniteNonNegativeNumber(args.currentGoal.createdAt)
      ?? nowMs,
    [args.counterField]: args.counterValue
  };
}

function readCurrentGoalState(args: {
  adapterContext: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
}): StoplessGoalProjection | undefined {
  const persisted = readPersistedGoalState(args.adapterContext);
  const metadataState = asGoalProjection(args.pipelineMetadata?.stoplessGoalState);
  const adapterState = asGoalProjection(args.adapterContext.stoplessGoalState);
  const candidates = [persisted, metadataState, adapterState].filter((candidate): candidate is StoplessGoalProjection => Boolean(candidate));
  if (!candidates.length) {
    return undefined;
  }
  return mergeGoalStateCandidates(candidates);
}

function asGoalProjection(value: unknown): StoplessGoalProjection | undefined {
  const record = asFlatRecord(value);
  return record && typeof record.status === 'string' && typeof record.objective === 'string'
    ? (record as StoplessGoalProjection)
    : undefined;
}

function readPersistedGoalState(adapterContext: Record<string, unknown>): StoplessGoalProjection | undefined {
  const persisted = asFlatRecord(readStoplessGoalState(adapterContext) as Record<string, unknown> | null);
  return asGoalProjection(persisted?.state);
}

function resolveGoalPersistenceScopeKey(adapterContext: Record<string, unknown>): string | undefined {
  const explicitScope = readNonEmptyString(adapterContext.stopMessageClientInjectSessionScope)
    ?? readNonEmptyString(adapterContext.stopMessageClientInjectScope);
  if (explicitScope) {
    return explicitScope;
  }
  const sessionId = readNonEmptyString(adapterContext.sessionId);
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const conversationId = readNonEmptyString(adapterContext.conversationId);
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  return undefined;
}

function mergeGoalStateCandidates(candidates: StoplessGoalProjection[]): StoplessGoalProjection {
  const canonical = [...candidates].sort((a, b) => {
    const updatedDiff =
      (readFiniteNonNegativeNumber(b.updatedAt) ?? 0)
      - (readFiniteNonNegativeNumber(a.updatedAt) ?? 0);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return (readFiniteNonNegativeNumber(b.createdAt) ?? 0) - (readFiniteNonNegativeNumber(a.createdAt) ?? 0);
  })[0]!;

  return {
    ...canonical,
    createdAt: candidates.reduce((min, candidate) => {
      const createdAt = readFiniteNonNegativeNumber(candidate.createdAt);
      return typeof createdAt === 'number' ? Math.min(min, createdAt) : min;
    }, readFiniteNonNegativeNumber(canonical.createdAt) ?? Date.now()),
    updatedAt: candidates.reduce((max, candidate) => {
      const updatedAt = readFiniteNonNegativeNumber(candidate.updatedAt);
      return typeof updatedAt === 'number' ? Math.max(max, updatedAt) : max;
    }, readFiniteNonNegativeNumber(canonical.updatedAt) ?? Date.now()),
    consecutiveIrrecoverableErrors: Math.max(...candidates.map((candidate) => normalizeGoalCounter(candidate.consecutiveIrrecoverableErrors))),
    consecutiveValidationFailures: Math.max(...candidates.map((candidate) => normalizeGoalCounter(candidate.consecutiveValidationFailures))),
    consecutiveNoProgress: Math.max(...candidates.map((candidate) => normalizeGoalCounter(candidate.consecutiveNoProgress)))
  };
}

function writeProjectedGoalState(args: {
  adapterContext: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
  state: StoplessGoalProjection;
}): StoplessGoalProjection {
  args.adapterContext.stoplessGoalState = args.state;
  const rt = asFlatRecord(args.adapterContext.__rt) ?? {};
  args.adapterContext.__rt = {
    ...rt,
    stoplessGoalStatus: args.state.status
  };
  if (hasGoalPersistenceScope(args.adapterContext)) {
    persistStoplessGoalStateSnapshot(args.adapterContext, args.state);
  }
  syncAdapterContextRuntimeBackToPipelineMetadata({
    pipelineMetadata: args.pipelineMetadata,
    adapterContext: args.adapterContext
  });
  return args.state;
}

function persistGoalProgressLedger(args: {
  adapterContext: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
  currentGoal: StoplessGoalProjection;
  requestId: string;
  finishReason?: string;
}): StoplessGoalProjection {
  const normalizedFinishReason = readNonEmptyString(args.finishReason)?.toLowerCase();
  const nowMs = Date.now();
  if (normalizedFinishReason === 'stop') {
    const nextCount = normalizeGoalCounter(args.currentGoal.consecutiveNoProgress) + 1;
    const details = [
      'Goal followup produced finish_reason=stop without observable progress.',
      `request_id=${args.requestId}`,
      'finish_reason=stop'
    ].join('\n');
    const state =
      nextCount >= GOAL_NO_PROGRESS_STOP_THRESHOLD
        ? buildHostForcedStoppedGoalState({
            currentGoal: args.currentGoal,
            errorClass: REPEATED_NO_PROGRESS_STOP_ERROR_CLASS,
            blockingEvidence: details,
            counterField: 'consecutiveNoProgress',
            counterValue: nextCount
          })
        : ({
            ...args.currentGoal,
            status: 'active',
            latestNote: details,
            consecutiveIrrecoverableErrors: 0,
            consecutiveValidationFailures: 0,
            consecutiveNoProgress: nextCount,
            updatedAt: nowMs,
            createdAt: readFiniteNonNegativeNumber(args.currentGoal.createdAt) ?? nowMs
          } as StoplessGoalProjection);
    return writeProjectedGoalState({
      adapterContext: args.adapterContext,
      pipelineMetadata: args.pipelineMetadata,
      state
    });
  }

  return writeProjectedGoalState({
    adapterContext: args.adapterContext,
    pipelineMetadata: args.pipelineMetadata,
    state: {
      ...args.currentGoal,
      consecutiveIrrecoverableErrors: 0,
      consecutiveValidationFailures: 0,
      consecutiveNoProgress: 0,
      updatedAt: nowMs,
      createdAt: readFiniteNonNegativeNumber(args.currentGoal.createdAt) ?? nowMs
    }
  });
}

function hasGoalPersistenceScope(adapterContext: Record<string, unknown>): boolean {
  const directScope = readNonEmptyString(adapterContext.stopMessageClientInjectSessionScope)
    ?? readNonEmptyString(adapterContext.stopMessageClientInjectScope);
  if (directScope) {
    return true;
  }
  return Boolean(
    readNonEmptyString(adapterContext.clientTmuxSessionId)
    ?? readNonEmptyString(adapterContext.client_tmux_session_id)
    ?? readNonEmptyString(adapterContext.tmuxSessionId)
    ?? readNonEmptyString(adapterContext.tmux_session_id)
    ?? readNonEmptyString(adapterContext.sessionId)
    ?? readNonEmptyString(adapterContext.conversationId)
  );
}

function readClientToolsRawForResponsesNormalization(args: {
  adapterContext?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
}): unknown[] {
  const adapterCapturedRequest = asFlatRecord(args.adapterContext?.capturedChatRequest);
  const adapterTools = Array.isArray(adapterCapturedRequest?.tools) ? adapterCapturedRequest.tools : undefined;
  if (adapterTools?.length) {
    return adapterTools;
  }
  const semanticsTools = asFlatRecord(args.requestSemantics?.tools);
  const clientToolsRaw = Array.isArray(semanticsTools?.clientToolsRaw) ? semanticsTools.clientToolsRaw : undefined;
  if (clientToolsRaw?.length) {
    return clientToolsRaw;
  }
  const rootTools = Array.isArray(args.requestSemantics?.tools) ? args.requestSemantics.tools : undefined;
  return rootTools?.length ? rootTools : [];
}

function normalizeResponsesToolCallsViaRustSsot(args: {
  payload: Record<string, unknown>;
  adapterContext?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  entryEndpoint?: string;
}): Record<string, unknown> {
  const entry = String(args.entryEndpoint || '').toLowerCase();
  if (!entry.includes('/v1/responses')) {
    return args.payload;
  }
  const toolsRaw = readClientToolsRawForResponsesNormalization({
    adapterContext: args.adapterContext,
    requestSemantics: args.requestSemantics
  });
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
    return args.payload;
  }
  return normalizeResponsesToolCallArgumentsForClientWithNative(args.payload, toolsRaw);
}

function persistGoalValidationLedger(args: {
  adapterContext: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
  currentGoal: StoplessGoalProjection;
  requestId: string;
  validationReason?: string;
  validationMessage?: string;
  missingFields?: string[];
}): StoplessGoalProjection {
  const nextCount = normalizeGoalCounter(args.currentGoal.consecutiveValidationFailures) + 1;
  const details = [
    'Goal update was rejected by host transition contract validation.',
    `request_id=${args.requestId}`,
    ...(args.validationReason ? [`validation_reason=${args.validationReason}`] : []),
    ...(args.validationMessage ? [`validation_message=${args.validationMessage}`] : []),
    ...(args.missingFields?.length ? [`missing_fields=${args.missingFields.join(',')}`] : [])
  ].join('\n');
  const state =
    nextCount >= GOAL_VALIDATION_FAILURE_STOP_THRESHOLD
      ? buildHostForcedStoppedGoalState({
          currentGoal: args.currentGoal,
          errorClass: REPEATED_VALIDATION_FAILURE_ERROR_CLASS,
          blockingEvidence: details,
          counterField: 'consecutiveValidationFailures',
          counterValue: nextCount
        })
      : ({
          ...args.currentGoal,
          status: 'active',
          latestNote: details,
          consecutiveIrrecoverableErrors: 0,
          consecutiveValidationFailures: nextCount,
          consecutiveNoProgress: 0,
          updatedAt: Date.now(),
          createdAt: readFiniteNonNegativeNumber(args.currentGoal.createdAt) ?? Date.now()
        } as StoplessGoalProjection);
  return writeProjectedGoalState({
    adapterContext: args.adapterContext,
    pipelineMetadata: args.pipelineMetadata,
    state
  });
}

function persistGoalIrrecoverableErrorLedger(args: {
  adapterContext: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
  currentGoal: StoplessGoalProjection;
  requestId: string;
  code?: string;
  upstreamCode?: string;
  reason?: string;
  message?: string;
}): StoplessGoalProjection {
  const nextCount = normalizeGoalCounter(args.currentGoal.consecutiveIrrecoverableErrors) + 1;
  const details = [
    'Goal followup failed irrecoverably and host stopped automatic continuation.',
    `request_id=${args.requestId}`,
    ...(args.code ? [`code=${args.code}`] : []),
    ...(args.upstreamCode ? [`upstream_code=${args.upstreamCode}`] : []),
    ...(args.reason ? [`reason=${args.reason}`] : []),
    ...(args.message ? [`message=${args.message}`] : [])
  ].join('\n');
  const state =
    nextCount >= GOAL_IRRECOVERABLE_ERROR_STOP_THRESHOLD
      ? buildHostForcedStoppedGoalState({
          currentGoal: args.currentGoal,
          errorClass: REPEATED_IRRECOVERABLE_ERROR_CLASS,
          blockingEvidence: details,
          counterField: 'consecutiveIrrecoverableErrors',
          counterValue: nextCount
        })
      : ({
          ...args.currentGoal,
          status: 'active',
          latestNote: details,
          consecutiveIrrecoverableErrors: nextCount,
          consecutiveValidationFailures: 0,
          consecutiveNoProgress: 0,
          updatedAt: Date.now(),
          createdAt: readFiniteNonNegativeNumber(args.currentGoal.createdAt) ?? Date.now()
        } as StoplessGoalProjection);
  return writeProjectedGoalState({
    adapterContext: args.adapterContext,
    pipelineMetadata: args.pipelineMetadata,
    state
  });
}

function logProviderResponseConverterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  logExecutorRuntimeNonBlockingWarning({
    namespace: 'provider-response-converter',
    stage,
    error,
    details,
    throttleKey: stage
  });
}

function isRecoverableSseDecodeBridgeError(error: Record<string, unknown>): boolean {
  return error.requestExecutorProviderErrorStage === 'provider.sse_decode' && error.retryable === true;
}

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ""
  ).trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}
function remapBridgeSseErrorToHttp(error: Record<string, unknown>, message: string): void {
  const detailRecord = asRecord(error.details);
  const upstreamCode =
    typeof error.upstreamCode === 'string'
      ? error.upstreamCode
      : typeof detailRecord?.upstreamCode === 'string'
        ? detailRecord.upstreamCode
        : undefined;
  const detailReason = typeof detailRecord?.reason === 'string' ? detailRecord.reason : undefined;
  const statusCodeRaw =
    typeof error.statusCode === 'number'
      ? error.statusCode
      : typeof error.status === 'number'
        ? error.status
        : typeof detailRecord?.statusCode === 'number'
          ? detailRecord.statusCode
          : undefined;
  const isContextLengthExceeded = isContextLengthExceededError(message, upstreamCode, detailReason);
  if (isContextLengthExceeded) {
    (error as any).status = 400;
    (error as any).statusCode = 400;
    (error as any).retryable = false;
    (error as any).code = 'CONTEXT_LENGTH_EXCEEDED';
    if (typeof error.upstreamCode !== 'string' || !String(error.upstreamCode).trim()) {
      (error as any).upstreamCode = upstreamCode || 'context_length_exceeded';
    }
    return;
  }
  if (isRateLimitLikeError(message, String(error.code || ''), upstreamCode)) {
    (error as any).status = 429;
    (error as any).statusCode = 429;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_429';
    return;
  }
  if (isRetryableNetworkSseWrapperError(message, upstreamCode, statusCodeRaw)) {
    (error as any).status = 502;
    (error as any).statusCode = 502;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_502';
  }
}

function syncAdapterContextRuntimeBackToPipelineMetadata(options: {
  pipelineMetadata?: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
}): void {
  const pipelineMetadata = asRecord(options.pipelineMetadata);
  if (!pipelineMetadata) {
    return;
  }
  const adapterRt = asRecord((options.adapterContext as Record<string, unknown>).__rt);
  const adapterGoalState = asRecord((options.adapterContext as Record<string, unknown>).stoplessGoalState);
  if (
    !adapterRt
    && !adapterGoalState
  ) {
    return;
  }
  const metadataRt = asRecord((pipelineMetadata as Record<string, unknown>).__rt) ?? {};
  (pipelineMetadata as Record<string, unknown>).__rt = {
    ...metadataRt,
    ...(Array.isArray(adapterRt?.hubStageTop) && adapterRt.hubStageTop.length > 0
      ? { hubStageTop: adapterRt.hubStageTop }
      : {}),
    ...(typeof adapterRt?.stoplessGoalStatus === 'string' && adapterRt.stoplessGoalStatus.trim()
      ? { stoplessGoalStatus: adapterRt.stoplessGoalStatus.trim() }
      : {}),
    ...(Array.isArray(adapterRt?.stoplessGoalDirectiveTypes) ? { stoplessGoalDirectiveTypes: adapterRt.stoplessGoalDirectiveTypes } : {})
  };
  if (adapterGoalState) {
    (pipelineMetadata as Record<string, unknown>).stoplessGoalState = adapterGoalState;
  }
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  providerKey?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  originalRequest?: Record<string, unknown> | undefined;
  requestSemantics?: Record<string, unknown> | undefined;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
};

export type ConvertProviderResponseDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
};

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  const body = options.response.body;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as Error & {
        code?: string;
        status?: number;
        statusCode?: number;
        retryable?: boolean;
        upstreamCode?: string;
        requestExecutorProviderErrorStage?: string;
      };
      error.code = 'SSE_DECODE_ERROR';
      error.requestExecutorProviderErrorStage = 'provider.sse_decode';
      if (wrapperError.errorCode) {
        error.upstreamCode = wrapperError.errorCode;
      }
      error.retryable = wrapperError.retryable;
      if (typeof wrapperError.statusCode === 'number' && Number.isFinite(wrapperError.statusCode)) {
        error.status = wrapperError.statusCode;
        error.statusCode = wrapperError.statusCode;
      }
      const isContextLengthExceeded = isContextLengthExceededError(wrapperError.message, wrapperError.errorCode);
      if (isContextLengthExceeded) {
        error.code = 'CONTEXT_LENGTH_EXCEEDED';
        error.status = 400;
        error.statusCode = 400;
        error.retryable = false;
        if (typeof error.upstreamCode !== 'string' || !error.upstreamCode.trim()) {
          error.upstreamCode = wrapperError.errorCode || 'context_length_exceeded';
        }
      }
      if (!isContextLengthExceeded && isRateLimitLikeError(wrapperError.message, wrapperError.errorCode)) {
        error.code = 'HTTP_429';
        error.status = 429;
        error.statusCode = 429;
        error.retryable = true;
      } else if (
        !isContextLengthExceeded &&
        isRetryableNetworkSseWrapperError(wrapperError.message, wrapperError.errorCode, wrapperError.statusCode)
      ) {
        error.code = 'HTTP_502';
        error.status = 502;
        error.statusCode = 502;
        error.retryable = true;
      } else if (wrapperError.retryable && error.statusCode === undefined) {
        error.status = 503;
        error.statusCode = 503;
      }
      throw error;
    }
  }
  if (options.processMode === 'passthrough' && !options.wantsStream && options.serverToolsEnabled === false) {
    return options.response;
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  if (!body || typeof body !== 'object') {
    return options.response;
  }
  let clientInjectWaitMs = 0;
  const attachTimingBreakdown = (result: PipelineExecutionResult): PipelineExecutionResult => {
    if (!(clientInjectWaitMs > 0)) {
      return result;
    }
    const existing = result.timingBreakdown;
    const nextClientInjectWaitMs = Math.max(
      0,
      Math.floor((existing?.clientInjectWaitMs ?? 0) + clientInjectWaitMs)
    );
    const nextHubResponseExcludedMs = Math.max(
      0,
      Math.floor((existing?.hubResponseExcludedMs ?? 0) + clientInjectWaitMs)
    );
    return {
      ...result,
      timingBreakdown: {
        ...existing,
        clientInjectWaitMs: nextClientInjectWaitMs,
        hubResponseExcludedMs: nextHubResponseExcludedMs
      }
    };
  };
  let adapterContext: Record<string, unknown> | undefined;
  try {
    const metadataBag = asRecord(options.pipelineMetadata);
    const baseContext = buildServerToolAdapterContext({
      metadata: metadataBag,
      originalRequest: options.originalRequest,
      requestSemantics: options.requestSemantics,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      serverToolsEnabled: options.serverToolsEnabled !== false,
      onReasoningStopSeedError: (error) => {
        logProviderResponseConverterNonBlockingError(
          'seedReasoningStopStateFromCapturedRequest',
          error
        );
      }
    });
    adapterContext = baseContext;
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    let stageRecorder: unknown;
    if (shouldEnableHubStageRecorder()) {
      logPipelineStage('convert.snapshot_recorder.start', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol
      });
      const snapshotRecorderStartMs = Date.now();
      stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
          ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
          : options.entryEndpoint || entry
      );
      logPipelineStage('convert.snapshot_recorder.completed', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol,
        elapsedMs: Date.now() - snapshotRecorderStartMs
      });
    }

    const providerInvoker = async (invokeOptions: {
      providerKey: string;
      providerType?: string;
      modelId?: string;
      providerProtocol: string;
      payload: Record<string, unknown>;
      entryEndpoint: string;
      requestId: string;
      routeHint?: string;
    }): Promise<{ providerResponse: Record<string, unknown> }> => {
      const providerInvokeStartMs = Date.now();
      logPipelineStage('convert.provider_invoke.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        providerProtocol: invokeOptions.providerProtocol,
        routeHint: invokeOptions.routeHint
      });
      if (invokeOptions.routeHint) {
        const carrier = invokeOptions.payload as { metadata?: Record<string, unknown> };
        const existingMeta =
          carrier.metadata && typeof carrier.metadata === 'object'
            ? (carrier.metadata as Record<string, unknown>)
            : {};
        carrier.metadata = {
          ...existingMeta,
          routeHint: existingMeta.routeHint ?? invokeOptions.routeHint
        };
      }

      const runtimeKey = deps.runtimeManager.resolveRuntimeKey(invokeOptions.providerKey);
      if (!runtimeKey) {
        throw new Error(`Runtime for provider ${invokeOptions.providerKey} not initialized`);
      }
      logPipelineStage('convert.provider_invoke.runtime_resolved', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
      if (!handle) {
        throw new Error(`Provider runtime ${runtimeKey} not found`);
      }
      logPipelineStage('convert.provider_invoke.send.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const providerSendStartMs = Date.now();
      const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
      logPipelineStage('convert.provider_invoke.send.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerSendStartMs
      });
      const normalizeStartMs = Date.now();
      const normalized = normalizeProviderResponse(providerResponse);
      logPipelineStage('convert.provider_invoke.normalize.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        status: normalized.status,
        elapsedMs: Date.now() - normalizeStartMs
      });
      const normalizedBodyRecord =
        normalized.body && typeof normalized.body === 'object'
          ? (normalized.body as Record<string, unknown>)
          : undefined;
      const bodyPayload =
        extractBridgeProviderResponsePayload(normalizedBodyRecord)
        ?? (normalizedBodyRecord
          ? normalizedBodyRecord
          : (normalized as unknown as Record<string, unknown>));
      logPipelineStage('convert.provider_invoke.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerInvokeStartMs
      });
      return { providerResponse: bodyPayload };
    };

    const reenterPipeline = async (reenterOpts: {
      entryEndpoint: string;
      requestId: string;
      body?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
      const reenterStartMs = Date.now();
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      logPipelineStage('convert.reenter.start', reenterOpts.requestId, {
        entryEndpoint: nestedEntry
      });
      const nestedResult = await executeServerToolReenterPipeline({
        entryEndpoint: reenterOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: reenterOpts.requestId,
        body: reenterOpts.body,
        metadata: reenterOpts.metadata,
        baseMetadata: metadataBag,
        requestSemantics: options.requestSemantics,
        executeNested: deps.executeNested,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('reenter.buildNestedMetadata.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      logPipelineStage('convert.reenter.completed', reenterOpts.requestId, {
        entryEndpoint: nestedEntry,
        elapsedMs: Date.now() - reenterStartMs
      });
      return nestedResult;
    };

    const clientInjectDispatch = async (injectOpts: {
      entryEndpoint: string;
      requestId: string;
      body?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ ok: boolean; reason?: string }> => {
      const clientInjectAttemptStartedAt = Date.now();
      const clientInjectStartMs = Date.now();
      logPipelineStage('convert.client_inject.start', injectOpts.requestId, {
        entryEndpoint: injectOpts.entryEndpoint || options.entryEndpoint || entry
      });
      const nestedEntry = injectOpts.entryEndpoint || options.entryEndpoint || entry;
      const injectResult = await executeServerToolClientInjectDispatch({
        entryEndpoint: injectOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: injectOpts.requestId,
        body: injectOpts.body,
        metadata: injectOpts.metadata,
        baseMetadata: metadataBag,
        requestSemantics: options.requestSemantics,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('clientInjectDispatch.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      clientInjectWaitMs += Math.max(0, Date.now() - clientInjectAttemptStartedAt);
      if (injectResult.ok) {
        logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
          entryEndpoint: nestedEntry,
          handled: true,
          elapsedMs: Date.now() - clientInjectStartMs
        });
        return { ok: true };
      }
      logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
        entryEndpoint: nestedEntry,
        handled: false,
        reason: injectResult.reason || 'client_inject_not_handled',
        elapsedMs: Date.now() - clientInjectStartMs
      });
      return { ok: false, reason: injectResult.reason || 'client_inject_not_handled' };
    };

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const bridgeProviderResponse =
      extractBridgeProviderResponsePayload(body as Record<string, unknown>)
      ?? (body as Record<string, unknown>);
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: options.providerProtocol,
      providerResponse: bridgeProviderResponse,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      requestSemantics: options.requestSemantics,
      providerInvoker: serverToolsEnabled ? providerInvoker : undefined,
      stageRecorder,
      reenterPipeline: serverToolsEnabled ? reenterPipeline : undefined,
      clientInjectDispatch: serverToolsEnabled ? clientInjectDispatch : undefined
    });
    syncAdapterContextRuntimeBackToPipelineMetadata({
      pipelineMetadata: options.pipelineMetadata,
      adapterContext
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      hasSse: Boolean(converted.__sse_responses),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    if (converted.body && typeof converted.body === 'object' && !Array.isArray(converted.body)) {
      converted.body = normalizeResponsesToolCallsViaRustSsot({
        payload: converted.body as Record<string, unknown>,
        adapterContext,
        requestSemantics: options.requestSemantics,
        entryEndpoint: options.entryEndpoint || entry
      });
    }
    if (converted.__sse_responses) {
      const usage = converted.body
        ? extractUsageFromResult(
          { body: converted.body },
          {
            providerProtocol: options.providerProtocol,
            providerType: options.providerType,
            providerKey: options.providerKey
          }
        )
        : undefined;
      const finishReason = deriveFinishReason(converted.body);
      logPipelineStage('convert.sse_wrapper_detected', options.requestId, {
        hasUsage: Boolean(usage),
        finishReason
      });
      return attachTimingBreakdown({
        ...options.response,
        body: buildServerToolSseWrapperBody({
          sseResponses: converted.__sse_responses,
          convertedBody: converted.body,
          usage
        })
      });
    }
    const effectiveGoalState = adapterContext
      ? readCurrentGoalState({
          adapterContext,
          pipelineMetadata: options.pipelineMetadata
        })
      : undefined;
    if (effectiveGoalState?.status === 'active' && adapterContext) {
      const finishReason = deriveFinishReason(converted.body ?? body);
      persistGoalProgressLedger({
        adapterContext,
        pipelineMetadata: options.pipelineMetadata,
        currentGoal: effectiveGoalState,
        requestId: options.requestId,
        finishReason
      });
    }
    return attachTimingBreakdown({
      ...options.response,
      body: converted.body ?? body
    });
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
    const requestExecutorProviderErrorStage =
      typeof errRecord.requestExecutorProviderErrorStage === 'string'
        ? errRecord.requestExecutorProviderErrorStage
        : undefined;
    const detailRecord = asRecord(errRecord.details);
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : typeof (detailRecord as Record<string, unknown> | undefined)?.error === 'string'
          ? String((detailRecord as Record<string, unknown>).error)
        : undefined;
    const validationReason =
      typeof errRecord.validationReason === 'string'
        ? errRecord.validationReason
        : typeof detailRecord?.validationReason === 'string'
          ? detailRecord.validationReason
          : undefined;
    const validationMessage =
      typeof errRecord.validationMessage === 'string'
        ? errRecord.validationMessage
        : typeof detailRecord?.validationMessage === 'string'
          ? detailRecord.validationMessage
          : undefined;
    const missingFields = Array.isArray(errRecord.missingFields)
      ? (errRecord.missingFields.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
      : Array.isArray(detailRecord?.missingFields)
        ? ((detailRecord.missingFields as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
        : undefined;
    const normalizedUpstreamCode = (upstreamCode || detailUpstreamCode || '').trim().toLowerCase();
    const fatalConversionCode =
      (typeof errCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(errCode) ? errCode : undefined)
      ?? (typeof upstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(upstreamCode) ? upstreamCode : undefined)
      ?? (typeof detailUpstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(detailUpstreamCode) ? detailUpstreamCode : undefined);

    if (fatalConversionCode) {
      if (adapterContext && fatalConversionCode === 'CLIENT_TOOL_ARGS_INVALID') {
        const currentGoal = readCurrentGoalState({
          adapterContext,
          pipelineMetadata: options.pipelineMetadata
        });
        if (currentGoal?.status === 'active') {
          persistGoalValidationLedger({
            adapterContext,
            pipelineMetadata: options.pipelineMetadata,
            currentGoal,
            requestId: options.requestId,
            validationReason,
            validationMessage,
            missingFields
          });
        }
      }
      logPipelineStage('convert.bridge.error', options.requestId, {
        code: errCode,
        upstreamCode: upstreamCode || detailUpstreamCode,
        reason: detailReason,
        message
      });
      throw error;
    }
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      errCode === 'HTTP_502' ||
      errCode === 'HTTP_429' ||
      (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
    const normalizedMessage = message.toLowerCase();
    const isContextLengthExceeded = isContextLengthExceededError(
      normalizedMessage,
      upstreamCode || detailUpstreamCode,
      detailReason
    );

    if (isGenericBridgeResponseContractError({ error: errRecord, message })) {
      errRecord.requestExecutorProviderErrorStage = 'host.response_contract';
    }

    const convertErrorPlan = finalizeServerToolBridgeConvertError({
      error,
      requestId: options.requestId,
      defaultFollowupStatus: 502,
      message,
      isSseDecodeError,
      isContextLengthExceeded,
      code: errCode,
      upstreamCode,
      detailUpstreamCode,
      detailReason
    });
    const effectiveErrorStage =
      typeof errRecord.requestExecutorProviderErrorStage === 'string'
        ? errRecord.requestExecutorProviderErrorStage
        : typeof detailRecord?.requestExecutorProviderErrorStage === 'string'
          ? detailRecord.requestExecutorProviderErrorStage
          : requestExecutorProviderErrorStage;
    const routecodexSemantics = asFlatRecord(options.requestSemantics?.__routecodex);
    const isServerToolFollowupRequest = routecodexSemantics?.serverToolFollowup === true;
    const isServerToolFollowupFailure =
      effectiveErrorStage === 'provider.followup' || isServerToolFollowupRequest;
    const followupLogDetails = isServerToolFollowupFailure
      ? extractServerToolFollowupErrorLogDetails(error)
      : undefined;
    const effectiveGoalState = adapterContext
      ? readCurrentGoalState({
          adapterContext,
          pipelineMetadata: options.pipelineMetadata
        })
      : undefined;

    if (
      effectiveGoalState?.status === 'active'
      && (effectiveErrorStage === 'provider.followup' || isServerToolFollowupRequest)
      && adapterContext
    ) {
      persistGoalIrrecoverableErrorLedger({
        adapterContext,
        pipelineMetadata: options.pipelineMetadata,
        currentGoal: effectiveGoalState,
        requestId: options.requestId,
        code: followupLogDetails?.code || errCode,
        upstreamCode: followupLogDetails?.upstreamCode || upstreamCode || detailUpstreamCode,
        reason: followupLogDetails?.reason || detailReason,
        message
      });
    }

    if (convertErrorPlan.handled) {
      if (isSseDecodeError || isContextLengthExceeded) {
        remapBridgeSseErrorToHttp(errRecord, message);
      }
      const nonFollowupStageDetails = {
        ...(convertErrorPlan.stageDetails ?? {}),
        code: followupLogDetails?.code || (typeof errRecord.code === 'string' ? errRecord.code : errCode),
        upstreamCode: followupLogDetails?.upstreamCode
          || (typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : upstreamCode || detailUpstreamCode),
        reason: followupLogDetails?.reason || compactFollowupLogReason(detailReason),
        message
      };
      const bridgeErrorStage = isRecoverableSseDecodeBridgeError(errRecord)
        ? 'convert.bridge.recoverable'
        : 'convert.bridge.error';
      logPipelineStage(bridgeErrorStage, options.requestId, {
        ...(isServerToolFollowupFailure
          ? (convertErrorPlan.stageDetails ?? {})
          : nonFollowupStageDetails)
      });
      if (isVerboseErrorLoggingEnabled()) {
        console.error(
          '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
          error
        );
      }
      throw error;
    }

    if (adapterContext && errCode === 'CLIENT_TOOL_ARGS_INVALID') {
      const currentGoal = readCurrentGoalState({
        adapterContext,
        pipelineMetadata: options.pipelineMetadata
      });
      if (currentGoal?.status === 'active') {
        persistGoalValidationLedger({
          adapterContext,
          pipelineMetadata: options.pipelineMetadata,
          currentGoal,
          requestId: options.requestId,
          validationReason,
          validationMessage,
          missingFields
        });
      }
    }

    logPipelineStage('convert.bridge.error', options.requestId, {
      code: errCode,
      upstreamCode: upstreamCode || detailUpstreamCode,
      reason: detailReason,
      message
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}
