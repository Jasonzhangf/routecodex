import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
// feature_id: server.provider_response_conversion_host
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
  readStoplessGoalState,
  resolveRelayResponsesClientSseStreamForHttp,
} from '../../../../modules/llmswitch/bridge.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { applyProviderConfiguredErrorMapping } from '../../../../providers/core/runtime/provider-configured-error-mapping.js';
import type { ProviderContext } from '../../../../providers/core/api/provider-types.js';
import type { ProviderErrorAugmented } from '../../../../providers/core/runtime/provider-error-types.js';
import {
  isEmptyOpenAiChatSseBridgeError,
  remapBridgeSseErrorToHttp
} from './provider-response-sse-error-normalizer.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  buildServerToolAdapterContext
} from './servertool-adapter-context.js';
import {
  compactFollowupLogReason,
  extractServerToolFollowupErrorLogDetails,
  finalizeServerToolBridgeConvertError
} from './servertool-followup-error.js';
import { importCoreDist } from '../../../../modules/llmswitch/bridge.js';

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
  STOPLESS_DIRECTIVE_PATTERN,
  shouldAllowDirectResponsesPrebuiltSsePassthrough
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

export function buildBridgeProviderResponseSeed(
  response: PipelineExecutionResult,
  body: unknown
): Record<string, unknown> | undefined {
  const responseRecord = response as unknown as Record<string, unknown>;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (
    responseRecord.data
    && typeof responseRecord.data === 'object'
    && !Array.isArray(responseRecord.data)
  ) {
    return responseRecord;
  }
  if (response.sseStream === undefined) {
    return undefined;
  }
  const seed: Record<string, unknown> = {
    sseStream: response.sseStream
  };
  if (typeof response.status === 'number') {
    seed.status = response.status;
  }
  if (response.headers && typeof response.headers === 'object' && !Array.isArray(response.headers)) {
    seed.headers = response.headers;
  }
  return seed;
}

function buildChoicesArrayBridgeDebugDetails(args: {
  message: string;
  bridgeProviderProtocol?: string;
  bridgeSeed?: Record<string, unknown>;
  bridgePayload?: Record<string, unknown>;
}): Record<string, unknown> {
  if (!args.message.toLowerCase().includes('choices array')) {
    return {};
  }
  const nestedData =
    args.bridgePayload?.data
    && typeof args.bridgePayload.data === 'object'
    && !Array.isArray(args.bridgePayload.data)
      ? (args.bridgePayload.data as Record<string, unknown>)
      : undefined;
  return {
    bridgeProviderProtocol: args.bridgeProviderProtocol,
    bridgeSeedKeys: args.bridgeSeed ? Object.keys(args.bridgeSeed) : undefined,
    bridgePayloadKeys: args.bridgePayload ? Object.keys(args.bridgePayload) : undefined,
    bridgePayloadHasChoices: Array.isArray(args.bridgePayload?.choices),
    bridgePayloadHasDataChoices: Array.isArray(nestedData?.choices)
  };
}

const GOAL_IRRECOVERABLE_ERROR_STOP_THRESHOLD = 5;
const GOAL_VALIDATION_FAILURE_STOP_THRESHOLD = 5;
const GOAL_NO_PROGRESS_STOP_THRESHOLD = 5;
const REPEATED_VALIDATION_FAILURE_ERROR_CLASS = 'repeated_validation_failure';
const REPEATED_IRRECOVERABLE_ERROR_CLASS = 'repeated_irrecoverable_error';
const REPEATED_NO_PROGRESS_STOP_ERROR_CLASS = 'repeated_no_progress_stop';
const PROVIDER_RESPONSE_RUNTIME_CONTROL_WRITER = {
  module: 'src/server/runtime/http-server/executor/provider-response-converter.ts',
  symbol: 'writeProjectedGoalState',
  stage: 'provider_response_runtime_control'
} as const;

type NativeRespSemanticsModule = {
  normalizeResponsesToolCallArgumentsForClientWithNative?: (
    responsesPayload: unknown,
    toolsRaw: unknown[]
  ) => Record<string, unknown>;
};

let nativeRespSemanticsModulePromise: Promise<NativeRespSemanticsModule> | null = null;

function attachTimingBreakdown(response: PipelineExecutionResult): PipelineExecutionResult {
  const clientInjectWaitMsRaw = response.usageLogInfo?.clientInjectWaitMs;
  const clientInjectWaitMs =
    typeof clientInjectWaitMsRaw === 'number' && Number.isFinite(clientInjectWaitMsRaw)
      ? Math.max(0, Math.floor(clientInjectWaitMsRaw))
      : undefined;
  if (clientInjectWaitMs === undefined) {
    return response;
  }
  return {
    ...response,
    timingBreakdown: {
      ...(response.timingBreakdown ?? {}),
      clientInjectWaitMs,
      hubResponseExcludedMs: response.timingBreakdown?.hubResponseExcludedMs ?? clientInjectWaitMs
    }
  };
}

async function loadNativeRespSemanticsModule(): Promise<NativeRespSemanticsModule> {
  if (!nativeRespSemanticsModulePromise) {
    nativeRespSemanticsModulePromise = importCoreDist<NativeRespSemanticsModule>(
      'native/router-hotpath/native-hub-pipeline-resp-semantics'
    );
  }
  return nativeRespSemanticsModulePromise;
}

async function normalizeResponsesToolCallArgumentsForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[]
): Promise<Record<string, unknown>> {
  const mod = await loadNativeRespSemanticsModule();
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
  const metadataState = asGoalProjection(
    MetadataCenter.read(args.pipelineMetadata)?.readRuntimeControl().stoplessGoal?.state
  );
  const adapterState = asGoalProjection(
    MetadataCenter.read(args.adapterContext)?.readRuntimeControl().stoplessGoal?.state
  );
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
  const adapterCenter = MetadataCenter.attach(args.adapterContext);
  adapterCenter.writeRuntimeControl(
    'stoplessGoal',
    {
      state: args.state,
      status: args.state.status
    },
    PROVIDER_RESPONSE_RUNTIME_CONTROL_WRITER,
    'provider response goal-state projection'
  );
  adapterCenter.writeRuntimeControl(
    'stoplessGoalStatus',
    args.state.status,
    PROVIDER_RESPONSE_RUNTIME_CONTROL_WRITER,
    'provider response goal-state projection'
  );
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
  const clientInject = MetadataCenter.read(adapterContext)?.readRuntimeControl().stopMessageClientInject;
  const directScope = readNonEmptyString(clientInject?.sessionScope);
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
  entryOriginRequest?: Record<string, unknown>;
}): unknown[] {
  const adapterCapturedRequest = asFlatRecord(args.adapterContext?.capturedEntryRequest) ?? asFlatRecord(args.adapterContext?.capturedChatRequest);
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
  if (rootTools?.length) {
    return rootTools;
  }
  const originalTools = Array.isArray(args.entryOriginRequest?.tools) ? args.entryOriginRequest.tools : undefined;
  return originalTools?.length ? originalTools : [];
}

async function normalizeResponsesToolCallsViaRustSsot(args: {
  payload: Record<string, unknown>;
  adapterContext?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  entryEndpoint?: string;
}): Promise<Record<string, unknown>> {
  const entry = String(args.entryEndpoint || '').toLowerCase();
  if (!entry.includes('/v1/responses')) {
    return args.payload;
  }
  const toolsRaw = readClientToolsRawForResponsesNormalization({
    adapterContext: args.adapterContext,
    requestSemantics: args.requestSemantics,
    entryOriginRequest: args.entryOriginRequest
  });
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
function syncAdapterContextRuntimeBackToPipelineMetadata(options: {
  pipelineMetadata?: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
}): void {
  const pipelineMetadata = asRecord(options.pipelineMetadata);
  if (!pipelineMetadata) {
    return;
  }
  const adapterCenter = MetadataCenter.read(options.adapterContext);
  const pipelineCenter = MetadataCenter.read(pipelineMetadata);
  if (adapterCenter && !pipelineCenter) {
    MetadataCenter.bind(pipelineMetadata, adapterCenter);
  } else if (adapterCenter && pipelineCenter && pipelineCenter !== adapterCenter) {
    const runtimeControl = adapterCenter.readRuntimeControl();
    const stoplessGoalStatus = runtimeControl.stoplessGoalStatus;
    if (runtimeControl.stoplessGoal) {
      pipelineCenter.writeRuntimeControl(
        'stoplessGoal',
        runtimeControl.stoplessGoal,
        PROVIDER_RESPONSE_RUNTIME_CONTROL_WRITER,
        'provider response goal-state pipeline sync'
      );
    }
    if (typeof stoplessGoalStatus === 'string' && stoplessGoalStatus.trim()) {
      pipelineCenter.writeRuntimeControl(
        'stoplessGoalStatus',
        stoplessGoalStatus.trim(),
        PROVIDER_RESPONSE_RUNTIME_CONTROL_WRITER,
        'provider response goal-state pipeline sync'
      );
    }
  }
  const adapterRt = asRecord((options.adapterContext as Record<string, unknown>).__rt);
  if (!adapterRt) {
    return;
  }
  const metadataRt = asRecord((pipelineMetadata as Record<string, unknown>).__rt) ?? {};
  (pipelineMetadata as Record<string, unknown>).__rt = {
    ...metadataRt,
    ...(Array.isArray(adapterRt?.hubStageTop) && adapterRt.hubStageTop.length > 0
      ? { hubStageTop: adapterRt.hubStageTop }
      : {})
  };
}

function readRuntimeControlForProviderResponseConverter(
  metadata?: Record<string, unknown>
): { serverToolFollowup?: boolean } {
  const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
  return {
    serverToolFollowup: runtimeControl?.serverToolFollowup === true
  };
}

export function buildResponseMetadataBagForProviderResponseConverter(args: {
  metadata?: Record<string, unknown>;
  providerFamily?: string;
}): Record<string, unknown> {
  const metadataBag = asRecord(args.metadata) ?? {};
  const providerFamily = typeof args.providerFamily === 'string' ? args.providerFamily.trim() : '';
  if (!providerFamily) {
    return metadataBag;
  }
  const responseMetadataBag: Record<string, unknown> = {
    ...metadataBag,
    providerFamily
  };
  const metadataCenter = MetadataCenter.read(metadataBag);
  if (metadataCenter) {
    MetadataCenter.bind(responseMetadataBag, metadataCenter);
  }
  return responseMetadataBag;
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  providerFamily?: string;
  providerKey?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  entryOriginRequest?: Record<string, unknown> | undefined;
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

function buildProviderContextForResponseConversion(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): ProviderContext {
  const runtimeKey = deps.runtimeManager.resolveRuntimeKey(options.providerKey, options.providerKey);
  const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
  const runtimeExtensions = asRecord(handle?.runtime?.extensions);
  const metadataExtensions = asRecord(options.pipelineMetadata?.extensions);
  const extensions = runtimeExtensions ?? metadataExtensions;
  const runtimeMetadata = {
    ...(asRecord(options.pipelineMetadata) ?? {}),
    ...(extensions ? { extensions } : {})
  };
  return {
    requestId: options.requestId,
    providerType: (options.providerType || 'unknown') as ProviderContext['providerType'],
    providerFamily: options.providerFamily,
    providerKey: options.providerKey,
    providerProtocol: options.providerProtocol,
    startTime: Date.now(),
    runtimeMetadata,
    extensions,
    ...(handle?.runtime ? { target: handle.runtime as unknown as ProviderContext['target'] } : {})
  };
}

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  let body = options.response.body;
  let bridgeSeedForError: Record<string, unknown> | undefined;
  let bridgePayloadForError: Record<string, unknown> | undefined;
  let bridgeProviderProtocolForError: string | undefined;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as ProviderErrorAugmented & {
        code?: string;
        status?: number;
        statusCode?: number;
        retryable?: boolean;
        upstreamCode?: string;
        requestExecutorProviderErrorStage?: string;
      };
      error.code = 'SSE_DECODE_ERROR';
      error.requestExecutorProviderErrorStage = 'provider.sse_decode';
      error.response = {
        data: {
          error: {
            code: wrapperError.errorCode,
            message: wrapperError.upstreamError?.message ?? wrapperError.message,
            status: wrapperError.statusCode,
            type: wrapperError.upstreamError?.type,
            param: wrapperError.upstreamError?.param
          }
        },
        status: wrapperError.statusCode
      };
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
      const mappedStatus = applyProviderConfiguredErrorMapping({
        normalized: error,
        context: buildProviderContextForResponseConversion(options, deps),
        statusCode: error.statusCode ?? error.status
      });
      if (mappedStatus !== undefined) {
        error.retryable = mappedStatus === 429 || error.retryable;
      }
      throw error;
    }
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  const bridgeProviderResponseSeed = buildBridgeProviderResponseSeed(options.response, body);
  if (!bridgeProviderResponseSeed) {
    return options.response;
  }
  bridgeSeedForError = bridgeProviderResponseSeed;
  body = bridgeProviderResponseSeed;
  const isDirectResponsesPrebuiltSsePassthrough = shouldAllowDirectResponsesPrebuiltSsePassthrough({
    entryEndpoint: options.entryEndpoint || entry,
    providerProtocol: options.providerProtocol,
    hasSseStream: options.response.sseStream !== undefined,
    continuationOwner: options.response.continuationOwner
  });
  if (isDirectResponsesPrebuiltSsePassthrough) {
    logPipelineStage('convert.bridge.prebuilt_sse_passthrough', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      continuationOwner: options.response.continuationOwner
    });
    return options.response;
  }
  let adapterContext: Record<string, unknown> | undefined;
  try {
    const responseMetadataBag = buildResponseMetadataBagForProviderResponseConverter({
      metadata: asRecord(options.pipelineMetadata),
      providerFamily: options.providerFamily
    });
    const baseContext = buildServerToolAdapterContext({
      metadata: responseMetadataBag,
      entryOriginRequest: options.entryOriginRequest,
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

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const bridgeProviderResponse =
      extractBridgeProviderResponsePayload(bridgeProviderResponseSeed)
      ?? bridgeProviderResponseSeed;
    bridgePayloadForError = bridgeProviderResponse;
    const bridgeProviderProtocol = options.providerProtocol;
    bridgeProviderProtocolForError = bridgeProviderProtocol;
    const effectiveRequestSemantics = (() => {
      const existing = asFlatRecord(options.requestSemantics);
      const existingTools = asFlatRecord(existing?.tools);
      const existingClientToolsRaw = Array.isArray(existingTools?.clientToolsRaw)
        ? existingTools.clientToolsRaw
        : Array.isArray(existing?.tools)
          ? existing.tools
          : undefined;
      if (existingClientToolsRaw?.length || !Array.isArray(options.entryOriginRequest?.tools) || options.entryOriginRequest.tools.length === 0) {
        return options.requestSemantics;
      }
      return {
        ...(existing ?? {}),
        tools: {
          ...(existingTools ?? {}),
          clientToolsRaw: options.entryOriginRequest.tools
        }
      };
    })();
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: bridgeProviderProtocol,
      providerResponse: bridgeProviderResponse,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      requestSemantics: effectiveRequestSemantics,
      stageRecorder
    });
    syncAdapterContextRuntimeBackToPipelineMetadata({
      pipelineMetadata: options.pipelineMetadata,
      adapterContext
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: bridgeProviderProtocol,
      hasSse: Boolean(converted.sseStream),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    if (converted.body && typeof converted.body === 'object' && !Array.isArray(converted.body)) {
      converted.body = await normalizeResponsesToolCallsViaRustSsot({
        payload: converted.body as Record<string, unknown>,
        adapterContext,
        requestSemantics: effectiveRequestSemantics,
        entryOriginRequest: options.entryOriginRequest,
        entryEndpoint: options.entryEndpoint || entry
      });
    }
    if (converted.sseStream) {
      const projectedRelayResponsesSseStream = await resolveRelayResponsesClientSseStreamForHttp({
        entryEndpoint: options.entryEndpoint || entry,
        continuationOwner: options.response.continuationOwner,
        sseStream: converted.sseStream,
        body:
          converted.body && typeof converted.body === 'object' && !Array.isArray(converted.body)
            ? converted.body as Record<string, unknown>
            : undefined,
        requestId: options.requestId,
      });
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
        body: converted.body,
        sseStream: projectedRelayResponsesSseStream,
        usageLogInfo: {
          ...(options.response.usageLogInfo ?? {}),
          requestStartedAtMs: options.response.usageLogInfo?.requestStartedAtMs ?? Date.now(),
          ...(usage ? { usage: usage as Record<string, unknown> } : {})
        }
      });
    }
    const effectiveGoalState = adapterContext
      ? readCurrentGoalState({
          adapterContext,
          pipelineMetadata: options.pipelineMetadata
        })
      : undefined;
    const finishReason = deriveFinishReason(converted.body ?? body);
    if (effectiveGoalState?.status === 'active' && adapterContext) {
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
        message,
        ...buildChoicesArrayBridgeDebugDetails({
          message,
          bridgeProviderProtocol: bridgeProviderProtocolForError,
          bridgeSeed: bridgeSeedForError,
          bridgePayload: bridgePayloadForError
        })
      });
      throw error;
    }
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      errCode === 'HTTP_502' ||
      errCode === 'HTTP_429' ||
      isEmptyOpenAiChatSseBridgeError(message) ||
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
    const isServerToolFollowupRequest =
      readRuntimeControlForProviderResponseConverter(options.pipelineMetadata).serverToolFollowup === true;
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
      message,
      ...buildChoicesArrayBridgeDebugDetails({
        message,
        bridgeProviderProtocol: bridgeProviderProtocolForError,
        bridgeSeed: bridgeSeedForError,
        bridgePayload: bridgePayloadForError
      })
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}
