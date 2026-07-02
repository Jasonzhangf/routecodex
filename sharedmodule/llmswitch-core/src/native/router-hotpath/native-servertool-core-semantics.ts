// Native bridge for servertool-core functions.
// Provides inspect_stop_gateway_signal, evaluate_loop_guard, calculate_budget.

import type { JsonObject } from '../../conversion/hub/types/json.js';
import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../../conversion/provider-protocol-error.js';
import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import { parseStopMessagePersistedLookupPlanPayload } from './native-router-hotpath-analysis.js';
import {
  buildServertoolOutcomePlanInputWithNative,
  planServertoolOutcomeWithNative
} from './native-chat-process-servertool-orchestration-semantics.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface StopGatewayContext {
  observed: boolean;
  eligible: boolean;
  source: 'chat' | 'responses' | 'none';
  reason: string;
  choiceIndex?: number;
  hasToolCalls?: boolean;
}

export interface LoopGuardInput {
  started_at_ms?: number;
  stop_pair_repeat_count?: number;
  stop_pair_warned?: boolean;
  now_ms?: number;
  warn_threshold: number;
  fail_threshold: number;
}

export interface LoopGuardOutput {
  should_inject_warning: boolean;
  stop_pair_warned?: boolean;
  hit_limit: boolean;
  elapsed_ms: number;
  repeat_count: number;
}

export interface BudgetDecision {
  observed: boolean;
  stop_eligible: boolean;
  next_used: number;
  max_repeats: number;
}

export interface StopMessageCompareContext {
  armed: boolean;
  mode: 'off' | 'on' | 'auto';
  allowModeOnly: boolean;
  textLength: number;
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  stopEligible: boolean;
  compactionRequest: boolean;
  hasSeed: boolean;
  decision: 'trigger' | 'skip';
  reason: string;
  stage?: string;
  bdWorkState?: string;
  observationHash?: string;
  observationStableCount?: number;
  toolSignatureHash?: string;
}

export interface BudgetSnapshot {
  text: string;
  max_repeats: number;
  used: number;
  source: string;
  stage_mode?: string;
  ai_mode?: string;
}

export interface DefaultBudgetConfig {
  enabled: boolean;
  text: string;
  max_repeats: number;
  is_non_active_managed_goal: boolean;
}

export type NativeServerToolExecution = {
  flowId: string;
  stopMessageReservation?: {
    stickyKey: string;
    previousState: Record<string, unknown> | null;
  };
};

export type NativeServerToolHandlerResult = {
  chatResponse: JsonObject;
  execution: NativeServerToolExecution;
  metadataWritePlan?: JsonObject;
};

export type NativeServertoolMaterializedEngineResult = {
  mode: 'tool_flow';
  finalChatResponse: JsonObject;
  execution: {
    flowId: string;
  };
};

export interface BudgetStateUpdatePlanInput {
  stopSignal: {
    observed: boolean;
    eligible: boolean;
    reason: string;
  };
  existingState?: Record<string, unknown> | null;
  snapshot?: BudgetSnapshot | null;
  defaultConfig?: DefaultBudgetConfig | null;
  nowMs: number;
}

export interface BudgetStateUpdatePlanOutput {
  observed: boolean;
  stopEligible: boolean;
  used?: number;
  maxRepeats?: number;
  shouldPersist: boolean;
  nextState?: Record<string, unknown> | null;
}

export interface PendingServerToolInjectionPlan {
  version: 1;
  sessionId: string;
  createdAtMs: number;
  afterToolCallIds: string[];
  messages: Record<string, unknown>[];
  sourceRequestId?: string;
}

export interface AutoHookTraceEventPlan {
  hookId: string;
  phase: string;
  priority: number;
  queue: 'A_optional' | 'B_mandatory';
  queueIndex: number;
  queueTotal: number;
  result: 'miss' | 'match' | 'error';
  reason: string;
  flowId?: string;
}

export interface AutoHookRuntimeAttemptPlan {
  action: 'return_result' | 'continue_queue' | 'rethrow_error';
  traceEvent: AutoHookTraceEventPlan;
  returnResult: boolean;
  continueQueue: boolean;
  rethrowError: boolean;
  errorMessage?: string;
}

export type AutoHookCallerFinalizationPlan =
  | {
      action: 'return_result';
      returnResult: true;
      continueNextQueue: false;
      returnNull: false;
      resultMode: 'tool_flow';
    }
  | {
      action: 'continue_next_queue';
      returnResult: false;
      continueNextQueue: true;
      returnNull: false;
    }
  | {
      action: 'return_null';
      returnResult: false;
      continueNextQueue: false;
      returnNull: true;
    };

export type AutoHookCallerResultProjectionPlan = {
  mode: 'tool_flow';
  includeMetadataWritePlan: boolean;
};

export interface EngineSelectionOverridesPlan {
  disableToolCallHandlers?: boolean;
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}

export interface EngineSelectionStartPlan {
  action: 'run_default' | 'run_primary_hooks';
  overrides: EngineSelectionOverridesPlan;
  primaryAutoHookIds: string[];
}

export type EngineSelectionAfterRunPlan = {
  action: 'return_current';
} | {
  action: 'rerun_excluding_primary_hooks';
  overrides: EngineSelectionOverridesPlan;
};

export interface ClientExecCliProjectionInput {
  toolName?: string;
  flowId?: string;
  input?: unknown;
  repeatCount?: number;
  maxRepeats?: number;
  stdoutPreview?: string;
  sessionDir?: string;
  sessionId?: string;
  requestId?: string;
}

export interface ClientExecCliProjectionOutput {
  toolName: string;
  flowId: string;
  execCommand: string;
  continuationPrompt?: string;
  repeatCount?: number;
  maxRepeats?: number;
  schemaGuidance?: unknown;
}

export interface ServertoolCliProjectionToolArgumentsInput {
  arguments: string;
}

export interface ClientVisibleProjectionShellInput {
  requestId: string;
  clientCallId: string;
  nativeProjection: ClientExecCliProjectionOutput;
  reasoningText: string;
  additionalToolCalls?: unknown[];
}

export interface ServertoolCliProjectionExecutionContextInput {
  requestId: string;
  clientCallId: string;
  toolName: string;
}

export interface ServertoolCliProjectionExecutionContextOutput {
  flowId: string;
}

export interface ServertoolCliProjectionRuntimeBranchInput {
  requestId: string;
  toolName: string;
  toolArguments: string;
  projectedToolCallId: string;
  base: Record<string, unknown>;
}

export interface ServertoolCliProjectionRuntimeBranchOutput {
  resultMode: 'tool_flow';
  chatResponse: JsonObject;
  execution: NativeServertoolExecutionSummary;
  result: {
    mode: 'tool_flow';
    finalChatResponse: JsonObject;
    execution: NativeServertoolExecutionSummary;
  };
}

export interface NativeServertoolExecutionSummary {
  flowId: string;
  context?: unknown;
}

export interface StoplessExecutionPlanOutput {
  execution: Record<string, unknown>;
  orchestrationPlan: {
    action: string;
    isStopMessageFlow: boolean;
    reason: string;
  };
}

export interface StoplessAutoCliProjectionFromEngineOutput {
  chatResponse: JsonObject;
}

export interface NativeServertoolExecutedToolCall {
  id: string;
  name: string;
  arguments: string;
  executionMode: string;
  stripAfterExecute: boolean;
}

export interface NativeServertoolExecutedRecord {
  toolCall: NativeServertoolExecutedToolCall;
  execution?: NativeServertoolExecutionSummary;
}

export interface NativeServertoolExecutionLoopState {
  executedToolCalls: NativeServertoolExecutedRecord[];
  executedIds: string[];
  executedFlowIds: string[];
  lastExecution?: NativeServertoolExecutionSummary;
}

export type ServertoolExecutionBranchPlan =
  | {
      action: 'client_exec_cli_projection';
      projectedToolCall: {
        id: string;
        name: string;
        arguments: string;
      };
      projectedToolCallId?: string;
      projectedToolCallIndex?: number;
    }
  | {
      action: 'resolve_execution_outcome' | 'continue_response_stage';
      projectedToolCall?: never;
      projectedToolCallId?: never;
      projectedToolCallIndex?: never;
    };

export interface ServertoolProjectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ServertoolEnginePreflightPlan {
  action:
    | 'return_original_chat'
    | 'return_original_chat_direct_passthrough'
    | 'continue_to_engine';
  attachStopGatewayContext: boolean;
  logStopEntry?: {
    stage: 'entry' | 'trigger';
    result: string;
    includeChoiceFacts: boolean;
  };
  logStopCompare?: {
    stage: 'entry' | 'trigger';
  };
}

export interface ServertoolEngineOrchestrationPreflightActionPlan {
  action: 'return_preflight_chat' | 'continue_engine';
}

export interface ServertoolEngineRuntimeActionPlan {
  action:
    | 'return_servertool_cli_projection_final'
    | 'return_stop_message_terminal_final'
    | 'build_stop_message_cli_projection';
  executed: true;
  flowIdSource: 'engine_execution' | 'current_flow';
  projectedFlowId?: string;
}

export interface ServertoolEngineTriggerObservationPlan {
  shouldLog: boolean;
  logStopEntry?: {
    stage: 'trigger';
    result: string;
  };
  logStopCompare?: {
    stage: 'trigger';
    flowId?: string;
  };
}

export type ServertoolEngineSkipPlan =
  | {
      action: 'return_skipped_passthrough' | 'return_skipped_no_execution';
      skipReason: string;
    }
  | {
      action: 'continue_matched_flow';
    };

export interface ServertoolExecutionOutcomeRuntimeActionPlan {
  action:
    | 'invalid_mixed_client_tools_outcome'
    | 'return_execution_contract'
    | 'missing_servertool_execution_contract';
  reuseLastExecutionEnvelope?: boolean;
  selectedExecutionEnvelope?: unknown;
  executionFlowId: string;
}

export type ServertoolExecutionOutcomeMaterializationPlan =
  | {
      action: 'throw_dispatch_error';
      errorPlan: ServertoolErrorPlan;
    }
  | {
      action: 'return_tool_flow';
      resultMode: 'tool_flow';
      executionFlowId: string;
    };

export interface ServertoolExecutionLoopRuntimeActionPlan {
  action:
    | 'skip_non_tool_call_handler'
    | 'throw_dispatch_spec_mismatch'
    | 'apply_materialized_result'
    | 'apply_handler_error_tool_output'
    | 'continue_without_effect';
}

function parseNativeJson(capability: string, raw: unknown): unknown {
  if (typeof raw !== 'string') {
    throw new Error(`native ${capability} returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as unknown;
}

export interface ServertoolExecutionLoopEffectBasePlan {
  toolCall: NativeServertoolExecutedRecord['toolCall'];
  execution: NativeServertoolExecutionSummary;
}

export interface ServertoolExecutionLoopHandlerErrorEffectPlan extends ServertoolExecutionLoopEffectBasePlan {
  handlerErrorMessage: string;
}

export type ServertoolExecutionLoopEffectPlan =
  | ServertoolExecutionLoopHandlerErrorEffectPlan
  | ServertoolExecutionLoopEffectBasePlan;

export type ServertoolResponseStageRuntimeActionPlan =
  | {
      action: 'return_passthrough_bypass' | 'return_passthrough_no_auto_hook_result';
      passthroughResult: {
        mode: 'passthrough';
        finalChatResponse: unknown;
      };
      skipReason?: string;
    }
  | {
      action: 'return_required_response_hook_empty';
      responseHookName: string;
    }
  | {
      action: 'run_auto_hooks' | 'return_auto_hook_result';
    };

export interface ServertoolResponseStageOrchestrationOutputPlan {
  returnAction: 'return_executed_payload' | 'return_original_payload';
  recordExecuted: boolean;
  recordFlowId?: string;
}

export interface ServertoolResponseStageOrchestrationMaterializedOutput {
  payload: JsonObject;
  executed: boolean;
  flowId?: string;
  returnedExecutedPayload: boolean;
}

export type ServertoolEntryPreflightPlan =
  | {
      action: 'return_passthrough_non_object_chat';
      passthroughResult: {
        mode: 'passthrough';
        finalChatResponse: unknown;
      };
    }
  | {
      action: 'throw_client_disconnected' | 'continue_to_tool_flow';
    };

export type ServertoolHandlerMaterializationPlan =
  | {
      action: 'finalize_without_backend';
    }
  | {
      action: 'return_handler_result';
    }
  | {
      action: 'throw_handler_error';
      errorPlan: ServertoolErrorPlan;
    };

export interface StoplessLearnedNoteWritePlanInput {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed?: Record<string, unknown>;
  timestampMs?: number;
}

export interface StoplessLearnedNoteWritePlan {
  shouldWrite: boolean;
  workingDirectory?: string;
  requestId: string;
  sessionId?: string;
  timestampMs: number;
  learned?: string;
  reason?: string;
  evidence?: string;
}

export interface StoplessCliProjectionMetadataWritePlan {
  stopless?: JsonObject;
}

export interface StoplessCliProjectionContextPlan {
  reasoningText: string;
  repeatCount: number;
  maxRepeats: number;
  publicTriggerHint?: string;
  schemaFeedback?: JsonObject;
  sessionId?: string;
  requestId?: string;
}

export type StopMessagePersistedLookupPlanOutput = ReturnType<typeof parseStopMessagePersistedLookupPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export interface RuntimeStopMessageStateSnapshot {
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
}

export interface StopMessageRoutingStateApplyPlan {
  source: string;
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode: 'on' | 'off';
  aiSeedPrompt?: string;
  aiHistory?: Array<Record<string, unknown>>;
}

export interface StopMessageRoutingStateClearPlan {
  timestamp: number;
}

export interface StoplessDecisionContextSignals {
  portStopMessageDisabled: boolean;
  hasResponsesSubmitToolOutputsResume: boolean;
  planModeActive: boolean;
}

export interface StopMessageDefaultConfigPlan {
  enabled: boolean;
  text: string;
  maxRepeats: number;
}

export interface StopMessagePersistSnapshotPlan {
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  source: string;
  stageMode: string;
  aiMode: 'off';
}

export interface StopMessagePersistPlan {
  compareMaxRepeats: number;
  compareRemaining: number;
  nextMaxRepeats: number;
  nextUsed: number;
  snapshot: StopMessagePersistSnapshotPlan;
}

export interface RuntimeStopMessageStateFromMetadataCenterInput {
  runtimeMetadata?: unknown;
}

export interface StopMessageDefaultSnapshotInput {
  base: unknown;
  adapterContext?: unknown;
  options?: {
    text?: unknown;
    maxRepeats?: unknown;
  };
}

export interface StopMessageImplicitGeminiSnapshotInput {
  base: unknown;
  adapterContext?: unknown;
  providerProtocol?: string;
  record: Record<string, unknown>;
}

export interface ServertoolRecordRuntimeMetadataInput {
  record: Record<string, unknown>;
  runtimeMetadata?: unknown;
}

export interface ServertoolLoopStateSnapshot {
  flowId?: string;
  payloadHash: string;
  repeatCount?: number;
  startedAtMs?: number;
  stopPairHash?: string;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
}

export interface ServertoolLoopStatePlanInput {
  flowId?: string;
  decision?: {
    flowOnlyLoopLimit?: boolean;
  };
  previousLoopState?: Record<string, unknown> | null;
  payloadHash?: string | null;
  stopPairHash?: string | null;
  nowMs: number;
}

export interface ServertoolTimeoutPolicyInput {
  raw?: unknown;
}

export interface ServertoolTimeoutWatcherPlan {
  armed: boolean;
  timeoutMs: number;
}

export interface ServertoolClientDisconnectWatcherPlan {
  intervalMs: number;
}

export interface ServertoolErrorPlan {
  message: string;
  code: string;
  category: string;
  status: number;
  details: Record<string, unknown>;
}

export interface StopMessageBlockedReport {
  summary: string;
  blocker: string;
  impact?: string;
  nextAction?: string;
  evidence: string[];
}

export type ServertoolHookDirection = 'request' | 'response';

export type ServertoolHookRequiredness = 'required' | 'optional';

export type ServertoolReqHookPhase =
  | 'servertoolReqHook01ResultParsed'
  | 'servertoolReqHook02TextRewritten'
  | 'servertoolReqHook03ToolInjected'
  | 'servertoolReqHook04RequestFinalized';

export type ServertoolRespHookPhase =
  | 'servertoolRespHook01Intercepted'
  | 'servertoolRespHook02SchemaValidated'
  | 'servertoolRespHook03HookResponseInjected'
  | 'servertoolRespHook04FollowupPlanned'
  | 'servertoolRespHook05ReenterDispatched'
  | 'servertoolRespHook06ProjectionFinalized';

export interface ServertoolHookSpec {
  id: string;
  direction: ServertoolHookDirection;
  reqPhase?: ServertoolReqHookPhase;
  respPhase?: ServertoolRespHookPhase;
  requiredness: ServertoolHookRequiredness;
  priority: number;
  order: number;
  ownerFeatureId: string;
  inputNode: string;
  outputNode: string;
  effectKind: string;
  enabled?: boolean;
}

export function planStoplessExecutionWithNative(input: {
  flowId?: string;
  execution: Record<string, unknown>;
  requestTruthSessionId?: string;
  metadataCenterSnapshot?: Record<string, unknown> | null;
  runtimeControl?: Record<string, unknown> | null;
}): StoplessExecutionPlanOutput {
  const capability = 'planStoplessExecutionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  const raw = fn(JSON.stringify({
    flowId: input.flowId ?? null,
    execution: input.execution,
    requestTruthSessionId: input.requestTruthSessionId ?? null,
    metadataCenterSnapshot: input.metadataCenterSnapshot ?? null,
    runtimeControl: input.runtimeControl ?? null
  }));
  const parsed = parseNativeJson(capability, raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned invalid stopless execution plan`);
  }
  const record = parsed as Record<string, unknown>;
  const execution = record.execution;
  const orchestrationPlan = record.orchestrationPlan;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error(`native ${capability} returned invalid stopless execution payload`);
  }
  if (
    !orchestrationPlan ||
    typeof orchestrationPlan !== 'object' ||
    Array.isArray(orchestrationPlan)
  ) {
    throw new Error(`native ${capability} returned invalid stopless orchestration plan`);
  }
  return {
    execution: execution as Record<string, unknown>,
    orchestrationPlan: orchestrationPlan as StoplessExecutionPlanOutput['orchestrationPlan']
  };
}

export function buildStoplessAutoCliProjectionFromEngineWithNative(input: {
  metadataCenterSnapshot?: Record<string, unknown> | null;
  execution?: unknown;
  metadataWritePlan?: unknown;
  requestId?: string | null;
}): StoplessAutoCliProjectionFromEngineOutput {
  const capability = 'buildStoplessAutoCliProjectionFromEngineJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  const parsed = parseNativeJson(capability, fn(JSON.stringify({
    metadataCenterSnapshot: input.metadataCenterSnapshot ?? null,
    execution: input.execution ?? null,
    metadataWritePlan: input.metadataWritePlan ?? null,
    requestId: input.requestId ?? null
  })));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned invalid projection output`);
  }
  const chatResponse = (parsed as Record<string, unknown>).chatResponse;
  if (!chatResponse || typeof chatResponse !== 'object' || Array.isArray(chatResponse)) {
    throw new Error(`native ${capability} returned invalid chatResponse`);
  }
  return {
    chatResponse: chatResponse as JsonObject
  };
}

export interface ServertoolHookSchedulerInput {
  direction: ServertoolHookDirection;
  reqPhase?: ServertoolReqHookPhase;
  respPhase?: ServertoolRespHookPhase;
  hooks: ServertoolHookSpec[];
  requireAtLeastOneRequiredHook?: boolean;
}

export interface ServertoolHookEvent {
  hookId: string;
  status: string;
  effectKind: string;
  requiredness: ServertoolHookRequiredness;
  noOp: boolean;
}

export interface ServertoolHookProjection {
  direction: ServertoolHookDirection;
  phase: string;
  inputNode: string;
  outputNode: string;
  hookIds: string[];
  effectKinds: string[];
}

export interface ServertoolHookEffectPlan {
  events: ServertoolHookEvent[];
  projection: ServertoolHookProjection;
}

export function extractTextFromChatLikeWithNative(payload: JsonObject): string {
  const capability = 'extractServertoolTextFromChatLikeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractServertoolTextFromChatLikeJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(payload));
  if (typeof resultJson !== 'string') {
    throw new Error(`extractServertoolTextFromChatLikeJson native returned non-string: ${typeof resultJson}`);
  }
  const result = JSON.parse(resultJson) as unknown;
  if (typeof result !== 'string') {
    throw new Error('extractServertoolTextFromChatLikeJson native returned invalid text');
  }
  return result;
}

// ── Stop gateway context ────────────────────────────────────────────────────

export function inspectStopGatewaySignalWithNative(payload: unknown): StopGatewayContext {
  const capability = 'inspectStopGatewaySignal';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('inspectStopGatewaySignal native unavailable');
  }
  const payloadJson = JSON.stringify(payload);
  const resultJson = fn(payloadJson);
  if (typeof resultJson !== 'string') {
    throw new Error(`inspectStopGatewaySignal native returned non-string: ${typeof resultJson}`);
  }
  const context = parseStopGatewayContextPayload(resultJson, capability);
  if (!context) {
    throw new Error('inspectStopGatewaySignal native returned null context');
  }
  return context;
}

export function normalizeStopGatewayContextWithNative(value: unknown): StopGatewayContext | undefined {
  const capability = 'normalizeStopGatewayContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('normalizeStopGatewayContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`normalizeStopGatewayContextJson native returned non-string: ${typeof resultJson}`);
  }
  return parseStopGatewayContextPayload(resultJson, capability) ?? undefined;
}

function parseStopGatewayContextPayload(resultJson: string, capability: string): StopGatewayContext | null {
  const raw = JSON.parse(resultJson) as unknown;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid context`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.observed !== 'boolean' || typeof record.eligible !== 'boolean') {
    throw new Error(`${capability} native returned invalid observed/eligible`);
  }
  const source = record.source;
  if (source !== 'chat' && source !== 'responses' && source !== 'none') {
    throw new Error(`${capability} native returned invalid source`);
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`${capability} native returned invalid reason`);
  }
  const choiceIndex = record.choice_index ?? record.choiceIndex;
  const hasToolCalls = record.has_tool_calls ?? record.hasToolCalls;
  return {
    observed: record.observed,
    eligible: record.eligible,
    source,
    reason: record.reason.trim(),
    ...(Number.isInteger(choiceIndex) ? { choiceIndex: choiceIndex as number } : {}),
    ...(typeof hasToolCalls === 'boolean' ? { hasToolCalls } : {}),
  };
}

export function extractStopMessageBlockedReportFromMessagesWithNative(messages: unknown[]): StopMessageBlockedReport | null {
  const capability = 'extractStopMessageBlockedReportFromMessagesJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractStopMessageBlockedReportFromMessagesJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(messages));
  if (typeof resultJson !== 'string') {
    throw new Error(`extractStopMessageBlockedReportFromMessagesJson native returned non-string: ${typeof resultJson}`);
  }
  const raw = JSON.parse(resultJson) as unknown;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('extractStopMessageBlockedReportFromMessagesJson native returned invalid report');
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.summary !== 'string' ||
    typeof record.blocker !== 'string' ||
    !Array.isArray(record.evidence) ||
    !record.evidence.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('extractStopMessageBlockedReportFromMessagesJson native returned invalid fields');
  }
  const nextAction = record.nextAction ?? record.next_action;
  return {
    summary: record.summary,
    blocker: record.blocker,
    ...(typeof record.impact === 'string' ? { impact: record.impact } : {}),
    ...(typeof nextAction === 'string' ? { nextAction } : {}),
    evidence: record.evidence
  };
}

export function normalizeStopMessageCompareContextWithNative(
  value: unknown,
): StopMessageCompareContext | undefined {
  const capability = 'normalizeStopMessageCompareContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('normalizeStopMessageCompareContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`normalizeStopMessageCompareContextJson native returned non-string: ${typeof resultJson}`);
  }
  return parseStopMessageCompareContextPayload(resultJson, capability) ?? undefined;
}

export function formatStopMessageCompareContextWithNative(value: unknown): string {
  const capability = 'formatStopMessageCompareContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('formatStopMessageCompareContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`formatStopMessageCompareContextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'string') {
    throw new Error('formatStopMessageCompareContextJson native returned invalid summary');
  }
  return parsed;
}

function parseStopMessageCompareContextPayload(resultJson: string, capability: string): StopMessageCompareContext | null {
  const raw = JSON.parse(resultJson) as unknown;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid compare context`);
  }
  const record = raw as Record<string, unknown>;
  const mode = record.mode;
  const decision = record.decision;
  if (mode !== 'off' && mode !== 'on' && mode !== 'auto') {
    throw new Error(`${capability} native returned invalid mode`);
  }
  if (decision !== 'trigger' && decision !== 'skip') {
    throw new Error(`${capability} native returned invalid decision`);
  }
  for (const key of [
    'armed',
    'allowModeOnly',
    'active',
    'stopEligible',
    'compactionRequest',
    'hasSeed',
  ]) {
    if (typeof record[key] !== 'boolean') {
      throw new Error(`${capability} native returned invalid boolean ${key}`);
    }
  }
  for (const key of ['textLength', 'maxRepeats', 'used', 'remaining']) {
    if (!Number.isInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error(`${capability} native returned invalid integer ${key}`);
    }
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`${capability} native returned invalid reason`);
  }
  return {
    armed: record.armed as boolean,
    mode,
    allowModeOnly: record.allowModeOnly as boolean,
    textLength: record.textLength as number,
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    remaining: record.remaining as number,
    active: record.active as boolean,
    stopEligible: record.stopEligible as boolean,
    compactionRequest: record.compactionRequest as boolean,
    hasSeed: record.hasSeed as boolean,
    decision,
    reason: record.reason.trim(),
    ...(typeof record.stage === 'string' && record.stage.trim() ? { stage: record.stage.trim() } : {}),
    ...(typeof record.bdWorkState === 'string' && record.bdWorkState.trim() ? { bdWorkState: record.bdWorkState.trim() } : {}),
    ...(typeof record.observationHash === 'string' && record.observationHash.trim() ? { observationHash: record.observationHash.trim() } : {}),
    ...(Number.isInteger(record.observationStableCount) ? { observationStableCount: record.observationStableCount as number } : {}),
    ...(typeof record.toolSignatureHash === 'string' && record.toolSignatureHash.trim() ? { toolSignatureHash: record.toolSignatureHash.trim() } : {}),
  };
}

// ── Loop guard ──────────────────────────────────────────────────────────────

export function evaluateLoopGuardWithNative(input: LoopGuardInput): LoopGuardOutput {
  const capability = 'evaluateLoopGuard';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('evaluateLoopGuard native unavailable');
  }
  const inputJson = JSON.stringify(input);
  const resultJson = fn(inputJson);
  if (typeof resultJson !== 'string') {
    throw new Error(`evaluateLoopGuard native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

// ── Budget counter ──────────────────────────────────────────────────────────

export function calculateBudgetWithNative(
  observed: boolean,
  stop_eligible: boolean,
  snapshot: BudgetSnapshot | undefined,
  default_config: DefaultBudgetConfig | undefined,
): BudgetDecision {
  const capability = 'calculateBudget';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('calculateBudget native unavailable');
  }
  const resultJson = fn(
    observed,
    stop_eligible,
    snapshot ? JSON.stringify(snapshot) : undefined,
    default_config ? JSON.stringify(default_config) : undefined,
  );
  if (typeof resultJson !== 'string') {
    throw new Error(`calculateBudget native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

export function planBudgetStateUpdateWithNative(
  input: BudgetStateUpdatePlanInput,
): BudgetStateUpdatePlanOutput {
  const capability = 'planBudgetStateUpdateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planBudgetStateUpdateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planBudgetStateUpdateJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planBudgetStateUpdateJson native returned invalid payload');
  }
  return parsed as BudgetStateUpdatePlanOutput;
}

export function resolveStopMessageSessionScopeWithNative(
  metadata: Record<string, unknown>,
): string | undefined {
  const capability = 'resolveStopMessageSessionScopeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveStopMessageSessionScopeJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(metadata));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveStopMessageSessionScopeJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}

export function resolveServertoolStickyKeyWithNative(
  metadata: Record<string, unknown>,
): string | undefined {
  const capability = 'resolveServertoolStickyKeyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveServertoolStickyKeyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(metadata));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveServertoolStickyKeyJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}

export function resolveServertoolStateKeyWithNative(
  metadata: Record<string, unknown>,
): string {
  const capability = 'resolveServertoolStateKeyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveServertoolStateKeyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(metadata));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveServertoolStateKeyJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'string' || !parsed.trim()) {
    throw new Error('resolveServertoolStateKeyJson native returned invalid state key');
  }
  return parsed.trim();
}

export function resolveRuntimeStopMessageStateWithNative(
  runtimeMetadata: unknown,
): RuntimeStopMessageStateSnapshot | null {
  const capability = 'resolveRuntimeStopMessageStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveRuntimeStopMessageStateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(runtimeMetadata ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveRuntimeStopMessageStateJson native returned non-string: ${typeof resultJson}`);
  }
  return parseRuntimeStopMessageStateSnapshotPayload(resultJson, 'resolveRuntimeStopMessageStateJson');
}

function parseRuntimeStopMessageStateSnapshotPayload(
  resultJson: string,
  capability: string,
): RuntimeStopMessageStateSnapshot | null {
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error(`${capability} native returned invalid text`);
  }
  if (!Number.isInteger(record.maxRepeats) || (record.maxRepeats as number) <= 0) {
    throw new Error(`${capability} native returned invalid maxRepeats`);
  }
  if (!Number.isInteger(record.used) || (record.used as number) < 0) {
    throw new Error(`${capability} native returned invalid used`);
  }
  const stageMode = readStopMessageStageModeField(record.stageMode, `${capability} stageMode`);
  const aiMode = readStopMessageAiModeField(record.aiMode, `${capability} aiMode`);
  return {
    text: record.text.trim(),
    ...(typeof record.providerKey === 'string' && record.providerKey.trim() ? { providerKey: record.providerKey.trim() } : {}),
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    ...(typeof record.source === 'string' && record.source.trim() ? { source: record.source.trim() } : {}),
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(stageMode ? { stageMode } : {}),
    ...(aiMode ? { aiMode } : {})
  };
}

export function readRuntimeStopMessageStageModeWithNative(
  runtimeMetadata: unknown,
): 'on' | 'off' | 'auto' | undefined {
  const capability = 'readRuntimeStopMessageStageModeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('readRuntimeStopMessageStageModeJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(runtimeMetadata ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`readRuntimeStopMessageStageModeJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return undefined;
  }
  const stageMode = readStopMessageStageModeField(parsed, 'readRuntimeStopMessageStageModeJson');
  if (!stageMode) {
    throw new Error('readRuntimeStopMessageStageModeJson native returned invalid stage mode');
  }
  return stageMode;
}

export function normalizeStopMessageStageModeValueWithNative(
  value: unknown,
): 'on' | 'off' | 'auto' | undefined {
  const capability = 'normalizeStopMessageStageModeValueJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('normalizeStopMessageStageModeValueJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`normalizeStopMessageStageModeValueJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return undefined;
  }
  const stageMode = readStopMessageStageModeField(parsed, 'normalizeStopMessageStageModeValueJson');
  if (!stageMode) {
    throw new Error('normalizeStopMessageStageModeValueJson native returned invalid stage mode');
  }
  return stageMode;
}

export function hasArmedStopMessageStateWithNative(state: unknown): boolean {
  const capability = 'hasArmedStopMessageStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('hasArmedStopMessageStateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(state ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`hasArmedStopMessageStateJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`hasArmedStopMessageStateJson native returned invalid bool: ${resultJson}`);
}

export function planStopMessageRoutingSnapshotWithNative(
  raw: unknown,
): RuntimeStopMessageStateSnapshot | null {
  const capability = 'planStopMessageRoutingSnapshotJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageRoutingSnapshotJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ raw }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessageRoutingSnapshotJson native returned non-string: ${typeof resultJson}`);
  }
  return parseRuntimeStopMessageStateSnapshotPayload(resultJson, capability);
}

export function planStopMessageRoutingStateApplyWithNative(
  snapshot: unknown,
): StopMessageRoutingStateApplyPlan {
  const capability = 'planStopMessageRoutingStateApplyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageRoutingStateApplyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ snapshot }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessageRoutingStateApplyJson native returned non-string: ${typeof resultJson}`);
  }
  return parseStopMessageRoutingStateApplyPayload(resultJson, capability);
}

export function planStopMessageRoutingStateClearWithNative(
  now: unknown,
): StopMessageRoutingStateClearPlan {
  const capability = 'planStopMessageRoutingStateClearJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageRoutingStateClearJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ now }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessageRoutingStateClearJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const timestamp = (parsed as Record<string, unknown>).timestamp;
  if (!Number.isInteger(timestamp)) {
    throw new Error(`${capability} native returned invalid timestamp`);
  }
  return { timestamp: timestamp as number };
}

export function planStoplessDecisionContextSignalsWithNative(input: {
  adapterContext: unknown;
  runtimeMetadata?: unknown;
}): StoplessDecisionContextSignals {
  const capability = 'planStoplessDecisionContextSignalsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStoplessDecisionContextSignalsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(encodeServertoolExecutionLoopEffectInput(input)));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStoplessDecisionContextSignalsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.portStopMessageDisabled !== 'boolean' ||
    typeof record.hasResponsesSubmitToolOutputsResume !== 'boolean' ||
    typeof record.planModeActive !== 'boolean'
  ) {
    throw new Error(`${capability} native returned invalid signal fields`);
  }
  return {
    portStopMessageDisabled: record.portStopMessageDisabled,
    hasResponsesSubmitToolOutputsResume: record.hasResponsesSubmitToolOutputsResume,
    planModeActive: record.planModeActive,
  };
}

export function planStopMessageDefaultConfigWithNative(input: {
  tombstoneCleared?: boolean;
  configEnabled?: unknown;
  configText?: unknown;
  configMaxRepeats?: unknown;
  envText?: unknown;
  envMaxRepeats?: unknown;
}): StopMessageDefaultConfigPlan {
  const capability = 'planStopMessageDefaultConfigJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageDefaultConfigJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessageDefaultConfigJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.enabled !== 'boolean' ||
    typeof record.text !== 'string' ||
    typeof record.maxRepeats !== 'number' ||
    !Number.isInteger(record.maxRepeats) ||
    record.maxRepeats <= 0
  ) {
    throw new Error(`${capability} native returned invalid default config fields`);
  }
  return {
    enabled: record.enabled,
    text: record.text,
    maxRepeats: record.maxRepeats,
  };
}

export function planStopMessagePersistSnapshotWithNative(input: {
  schemaGate: unknown;
  decision: unknown;
  stateUpdate?: unknown;
  defaultText?: string;
  schemaUsedBeforeCount?: unknown;
  currentProviderKey?: string;
}): StopMessagePersistPlan {
  const capability = 'planStopMessagePersistSnapshotJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessagePersistSnapshotJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessagePersistSnapshotJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  const snapshot = record.snapshot as Record<string, unknown> | undefined;
  if (
    typeof record.compareMaxRepeats !== 'number' ||
    typeof record.compareRemaining !== 'number' ||
    typeof record.nextMaxRepeats !== 'number' ||
    typeof record.nextUsed !== 'number' ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    typeof snapshot.text !== 'string' ||
    typeof snapshot.maxRepeats !== 'number' ||
    typeof snapshot.used !== 'number' ||
    typeof snapshot.source !== 'string' ||
    typeof snapshot.stageMode !== 'string' ||
    snapshot.aiMode !== 'off'
  ) {
    throw new Error(`${capability} native returned invalid persist plan fields`);
  }
  return record as unknown as StopMessagePersistPlan;
}

function readStopMessageStageModeField(value: unknown, source: string): 'on' | 'off' | 'auto' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'on' || value === 'off' || value === 'auto') {
    return value;
  }
  throw new Error(`${source} returned invalid stop-message stage mode`);
}

function readStopMessageAiModeField(value: unknown, source: string): 'on' | 'off' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'on' || value === 'off') {
    return value;
  }
  throw new Error(`${source} returned invalid stop-message ai mode`);
}

function parseStopMessageRoutingStateApplyPayload(
  resultJson: string,
  capability: string,
): StopMessageRoutingStateApplyPlan {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.source !== 'string' || !record.source.trim()) {
    throw new Error(`${capability} native returned invalid source`);
  }
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error(`${capability} native returned invalid text`);
  }
  if (!Number.isInteger(record.maxRepeats) || (record.maxRepeats as number) <= 0) {
    throw new Error(`${capability} native returned invalid maxRepeats`);
  }
  if (!Number.isInteger(record.used) || (record.used as number) < 0) {
    throw new Error(`${capability} native returned invalid used`);
  }
  const stageMode = readStopMessageStageModeField(record.stageMode, `${capability} stageMode`);
  const aiMode = readStopMessageAiModeField(record.aiMode, `${capability} aiMode`);
  if (!aiMode) {
    throw new Error(`${capability} native returned invalid aiMode`);
  }
  const aiHistory = record.aiHistory;
  if (aiHistory !== undefined && !Array.isArray(aiHistory)) {
    throw new Error(`${capability} native returned invalid aiHistory`);
  }
  return {
    source: record.source.trim(),
    text: record.text.trim(),
    ...(typeof record.providerKey === 'string' && record.providerKey.trim() ? { providerKey: record.providerKey.trim() } : {}),
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(stageMode ? { stageMode } : {}),
    aiMode,
    ...(typeof record.aiSeedPrompt === 'string' && record.aiSeedPrompt.trim() ? { aiSeedPrompt: record.aiSeedPrompt.trim() } : {}),
    ...(Array.isArray(aiHistory) ? { aiHistory: aiHistory as Array<Record<string, unknown>> } : {}),
  };
}

export function planStopMessagePersistedLookupWithNative(input: {
  record: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
  options?: {
    includeSnapshotLookup?: boolean;
    includeTombstoneLookup?: boolean;
  };
}): StopMessagePersistedLookupPlanOutput {
  const capability = 'planStopMessagePersistedLookupJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessagePersistedLookupJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStopMessagePersistedLookupJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = parseStopMessagePersistedLookupPlanPayload(resultJson);
  if (!parsed) {
    throw new Error('planStopMessagePersistedLookupJson native returned invalid payload');
  }
  return parsed;
}

export function buildClientExecCliProjectionOutputWithNative(
  input: ClientExecCliProjectionInput,
): ClientExecCliProjectionOutput {
  const capability = 'buildClientExecCliProjectionOutputJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildClientExecCliProjectionOutputJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    const message = typeof nativeError.message === 'string' && nativeError.message.trim()
      ? nativeError.message.trim()
      : JSON.stringify(nativeError);
    throw new Error(`buildClientExecCliProjectionOutputJson native error: ${message}`);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`buildClientExecCliProjectionOutputJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

export function parseServertoolCliProjectionToolArgumentsWithNative(
  input: ServertoolCliProjectionToolArgumentsInput,
): Record<string, unknown> {
  const capability = 'parseServertoolCliProjectionToolArgumentsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('parseServertoolCliProjectionToolArgumentsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    const message = typeof nativeError.message === 'string' && nativeError.message.trim()
      ? nativeError.message.trim()
      : JSON.stringify(nativeError);
    throw new Error(`parseServertoolCliProjectionToolArgumentsJson native error: ${message}`);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`parseServertoolCliProjectionToolArgumentsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parseServertoolCliProjectionToolArgumentsJson native returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

export function planStopMessageAutoHandlerWithNative<TPlan extends Record<string, unknown>>(
  input: Record<string, unknown>,
): TPlan {
  const capability = 'planStopMessageAutoHandlerJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageAutoHandlerJson native unavailable');
  }
  const raw = fn(JSON.stringify(input));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as TPlan;
  }
  if (typeof raw !== 'string') {
    throw new Error(`planStopMessageAutoHandlerJson native returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as TPlan;
}

export function planStoplessCliProjectionContextWithNative(input: {
  metadataWritePlan?: StoplessCliProjectionMetadataWritePlan | null;
  stoplessControl?: unknown;
  chatStopText?: string;
  adapterStopText?: string;
  sessionId?: string;
  requestId?: string;
}): StoplessCliProjectionContextPlan {
  const capability = 'planStoplessCliProjectionContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStoplessCliProjectionContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStoplessCliProjectionContextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.reasoningText !== 'string' || !record.reasoningText.trim()) {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid reasoningText');
  }
  if (typeof record.repeatCount !== 'number' || !Number.isFinite(record.repeatCount) || record.repeatCount < 1) {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid repeatCount');
  }
  if (typeof record.maxRepeats !== 'number' || !Number.isFinite(record.maxRepeats) || record.maxRepeats < 1) {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid maxRepeats');
  }
  if (record.publicTriggerHint !== undefined && typeof record.publicTriggerHint !== 'string') {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid publicTriggerHint');
  }
  if (
    record.schemaFeedback !== undefined &&
    (!record.schemaFeedback || typeof record.schemaFeedback !== 'object' || Array.isArray(record.schemaFeedback))
  ) {
    throw new Error('planStoplessCliProjectionContextJson native returned invalid schemaFeedback');
  }
  return {
    reasoningText: record.reasoningText,
    repeatCount: record.repeatCount,
    maxRepeats: record.maxRepeats,
    ...(typeof record.publicTriggerHint === 'string' && record.publicTriggerHint.trim()
      ? { publicTriggerHint: record.publicTriggerHint }
      : {}),
    ...(record.schemaFeedback && typeof record.schemaFeedback === 'object' && !Array.isArray(record.schemaFeedback)
      ? { schemaFeedback: record.schemaFeedback as JsonObject }
      : {})
    ,
    ...(typeof record.sessionId === 'string' && record.sessionId.trim()
      ? { sessionId: record.sessionId.trim() }
      : {}),
    ...(typeof record.requestId === 'string' && record.requestId.trim()
      ? { requestId: record.requestId.trim() }
      : {})
  };
}

export function normalizeStoplessTriggerHintForMetadataWithNative(reasonCode: unknown): string {
  const capability = 'normalizeStoplessTriggerHintForMetadataJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('normalizeStoplessTriggerHintForMetadataJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    ...(typeof reasonCode === 'string' ? { reasonCode } : {})
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`normalizeStoplessTriggerHintForMetadataJson native returned non-string: ${typeof resultJson}`);
  }
  return resultJson;
}

export function planStoplessLearnedNoteWriteWithNative(
  input: StoplessLearnedNoteWritePlanInput,
): StoplessLearnedNoteWritePlan {
  const capability = 'planStoplessLearnedNoteWriteJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStoplessLearnedNoteWriteJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    if (nativeError instanceof Error || typeof nativeError.message === 'string' || typeof nativeError.code === 'string') {
      const message = typeof nativeError.message === 'string' && nativeError.message.trim()
        ? nativeError.message.trim()
        : String(resultJson);
      throw new Error(`planStoplessLearnedNoteWriteJson native error: ${message}`);
    }
  }
  const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) as unknown : resultJson;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planStoplessLearnedNoteWriteJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.shouldWrite !== 'boolean' ||
    typeof record.requestId !== 'string' ||
    typeof record.timestampMs !== 'number'
  ) {
    throw new Error(`planStoplessLearnedNoteWriteJson native returned invalid fields: ${JSON.stringify(record)}`);
  }
  return record as unknown as StoplessLearnedNoteWritePlan;
}

export function validateServertoolHookSkeletonPhaseWithNative(
  input: ServertoolHookSpec,
): ServertoolHookProjection {
  const capability = 'validateServertoolHookSkeletonPhaseJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('validateServertoolHookSkeletonPhaseJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`validateServertoolHookSkeletonPhaseJson native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolHookProjectionPayload(resultJson, capability);
}

export function planServertoolHookScheduleWithNative(
  input: ServertoolHookSchedulerInput,
): ServertoolHookEffectPlan {
  const capability = 'planServertoolHookScheduleJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolHookScheduleJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolHookScheduleJson native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolHookEffectPlanPayload(resultJson, capability);
}

function parseServertoolHookEffectPlanPayload(
  resultJson: string,
  capability: string,
): ServertoolHookEffectPlan {
  const raw = JSON.parse(resultJson) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid effect plan`);
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.events)) {
    throw new Error(`${capability} native returned invalid events`);
  }
  return {
    events: record.events.map((event) => parseServertoolHookEvent(event, capability)),
    projection: parseServertoolHookProjectionRecord(record.projection, capability),
  };
}

function parseServertoolHookProjectionPayload(
  resultJson: string,
  capability: string,
): ServertoolHookProjection {
  return parseServertoolHookProjectionRecord(JSON.parse(resultJson) as unknown, capability);
}

function parseServertoolHookProjectionRecord(
  raw: unknown,
  capability: string,
): ServertoolHookProjection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid projection`);
  }
  const record = raw as Record<string, unknown>;
  if (
    (record.direction !== 'request' && record.direction !== 'response') ||
    typeof record.phase !== 'string' ||
    typeof record.inputNode !== 'string' ||
    typeof record.outputNode !== 'string' ||
    !Array.isArray(record.hookIds) ||
    !record.hookIds.every((value) => typeof value === 'string') ||
    !Array.isArray(record.effectKinds) ||
    !record.effectKinds.every((value) => typeof value === 'string')
  ) {
    throw new Error(`${capability} native returned invalid projection fields`);
  }
  return record as unknown as ServertoolHookProjection;
}

function parseServertoolHookEvent(raw: unknown, capability: string): ServertoolHookEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid hook event`);
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.hookId !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.effectKind !== 'string' ||
    (record.requiredness !== 'required' && record.requiredness !== 'optional') ||
    typeof record.noOp !== 'boolean'
  ) {
    throw new Error(`${capability} native returned invalid hook event fields`);
  }
  return record as unknown as ServertoolHookEvent;
}

export function buildClientVisibleProjectionShellWithNative(
  input: ClientVisibleProjectionShellInput,
): Record<string, unknown> {
  const capability = 'buildClientVisibleProjectionShellJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildClientVisibleProjectionShellJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    const message = typeof nativeError.message === 'string' && nativeError.message.trim()
      ? nativeError.message.trim()
      : JSON.stringify(nativeError);
    throw new Error(`buildClientVisibleProjectionShellJson native error: ${message}`);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`buildClientVisibleProjectionShellJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildClientVisibleProjectionShellJson native returned invalid projection shell');
  }
  return parsed as Record<string, unknown>;
}

export function buildServertoolCliProjectionExecutionContextWithNative(
  input: ServertoolCliProjectionExecutionContextInput,
): ServertoolCliProjectionExecutionContextOutput {
  const capability = 'buildServertoolCliProjectionExecutionContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildServertoolCliProjectionExecutionContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    const message = typeof nativeError.message === 'string' && nativeError.message.trim()
      ? nativeError.message.trim()
      : JSON.stringify(nativeError);
    throw new Error(`buildServertoolCliProjectionExecutionContextJson native error: ${message}`);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`buildServertoolCliProjectionExecutionContextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildServertoolCliProjectionExecutionContextJson native returned invalid projection context');
  }
  const record = parsed as Record<string, unknown>;
  if (record.flowId !== 'servertool_cli_projection') {
    throw new Error('buildServertoolCliProjectionExecutionContextJson native returned invalid projection context fields');
  }
  return {
    flowId: 'servertool_cli_projection'
  };
}

export function buildServertoolCliProjectionRuntimeBranchWithNative(
  input: ServertoolCliProjectionRuntimeBranchInput,
): ServertoolCliProjectionRuntimeBranchOutput {
  const capability = 'buildServertoolCliProjectionRuntimeBranchJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    const nativeError = resultJson as Record<string, unknown>;
    const message = typeof nativeError.message === 'string' && nativeError.message.trim()
      ? nativeError.message.trim()
      : JSON.stringify(nativeError);
    throw new Error(`buildServertoolCliProjectionRuntimeBranchJson native error: ${message}`);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`buildServertoolCliProjectionRuntimeBranchJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid branch');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.chatResponse || typeof record.chatResponse !== 'object' || Array.isArray(record.chatResponse)) {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid chatResponse');
  }
  if (record.resultMode !== 'tool_flow') {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid resultMode');
  }
  const execution = record.execution as Record<string, unknown> | undefined;
  if (!execution || execution.flowId !== 'servertool_cli_projection') {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid execution');
  }
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid result');
  }
  const result = record.result as Record<string, unknown>;
  if (result.mode !== 'tool_flow') {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid result mode');
  }
  if (!result.finalChatResponse || typeof result.finalChatResponse !== 'object' || Array.isArray(result.finalChatResponse)) {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid result finalChatResponse');
  }
  const resultExecution = result.execution as Record<string, unknown> | undefined;
  if (!resultExecution || resultExecution.flowId !== 'servertool_cli_projection') {
    throw new Error('buildServertoolCliProjectionRuntimeBranchJson native returned invalid result execution');
  }
  return {
    resultMode: 'tool_flow',
    chatResponse: record.chatResponse as JsonObject,
    execution: {
      flowId: 'servertool_cli_projection'
    },
    result: {
      mode: 'tool_flow',
      finalChatResponse: result.finalChatResponse as JsonObject,
      execution: {
        flowId: 'servertool_cli_projection'
      }
    }
  };
}

export function validateClientExecCommandResultWithNative(rawOutput: string): Record<string, unknown> {
  const capability = 'validateClientExecCommandResultJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('validateClientExecCommandResultJson native unavailable');
  }
  const resultJson = fn(rawOutput);
  if (typeof resultJson !== 'string') {
    throw new Error(`validateClientExecCommandResultJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as Record<string, unknown>;
}

export function resolveRuntimeStopMessageStateFromMetadataCenterWithNative(
  input: RuntimeStopMessageStateFromMetadataCenterInput,
): RuntimeStopMessageStateSnapshot | null {
  const capability = 'resolveRuntimeStopMessageStateFromMetadataCenterJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveRuntimeStopMessageStateFromMetadataCenterJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveRuntimeStopMessageStateFromMetadataCenterJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as RuntimeStopMessageStateSnapshot | null;
}

export function resolveBdWorkingDirectoryForRecordWithNative(
  input: ServertoolRecordRuntimeMetadataInput,
): string | undefined {
  const capability = 'resolveBdWorkingDirectoryForRecordJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveBdWorkingDirectoryForRecordJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveBdWorkingDirectoryForRecordJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as string | null;
  return typeof parsed === 'string' && parsed.length ? parsed : undefined;
}

export function resolveStopMessageFollowupProviderKeyWithNative(
  input: ServertoolRecordRuntimeMetadataInput,
): string {
  const capability = 'resolveStopMessageFollowupProviderKeyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveStopMessageFollowupProviderKeyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveStopMessageFollowupProviderKeyJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as string;
  return typeof parsed === 'string' ? parsed : '';
}

export function resolveClientConnectionStateWithNative(value: unknown): { disconnected?: boolean } | null {
  const capability = 'resolveClientConnectionStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveClientConnectionStateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveClientConnectionStateJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as { disconnected?: boolean }
    : null;
}

export function hasCompactionFlagWithNative(runtimeMetadata: unknown): boolean {
  const capability = 'hasCompactionFlagJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('hasCompactionFlagJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(runtimeMetadata));
  if (typeof resultJson !== 'string') {
    throw new Error(`hasCompactionFlagJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`hasCompactionFlagJson native returned invalid bool: ${resultJson}`);
}

export function resolveEntryEndpointWithNative(record: Record<string, unknown>): string {
  const capability = 'resolveEntryEndpointJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveEntryEndpointJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(record));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveEntryEndpointJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' && parsed.trim().length ? parsed : '/v1/chat/completions';
}

export function resolveStopMessageFollowupToolContentMaxCharsWithNative(input: {
  envValue?: unknown;
  providerKey?: string;
  model?: string;
}): number | undefined {
  const capability = 'resolveStopMessageFollowupToolContentMaxCharsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveStopMessageFollowupToolContentMaxCharsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveStopMessageFollowupToolContentMaxCharsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

export function planAutoHookRuntimeAttemptWithNative(input: {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  hasPlannedResult?: boolean;
  hasMaterializedResult?: boolean;
  error?: unknown;
  materializedFlowId?: string;
}): AutoHookRuntimeAttemptPlan {
  const capability = 'planAutoHookRuntimeAttemptJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookRuntimeAttemptJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(encodeAutoHookRuntimeAttemptInput(input)));
  if (typeof resultJson !== 'string') {
    throw new Error(`planAutoHookRuntimeAttemptJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  const trace = record.traceEvent;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid traceEvent');
  }
  const traceRecord = trace as Record<string, unknown>;
  if (
    record.action !== 'return_result' &&
    record.action !== 'continue_queue' &&
    record.action !== 'rethrow_error'
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid action');
  }
  if (
    typeof traceRecord.hookId !== 'string' ||
    typeof traceRecord.phase !== 'string' ||
    typeof traceRecord.priority !== 'number' ||
    typeof traceRecord.queue !== 'string' ||
    typeof traceRecord.queueIndex !== 'number' ||
    typeof traceRecord.queueTotal !== 'number' ||
    (traceRecord.result !== 'miss' && traceRecord.result !== 'match' && traceRecord.result !== 'error') ||
    typeof traceRecord.reason !== 'string' ||
    typeof record.returnResult !== 'boolean' ||
    typeof record.continueQueue !== 'boolean' ||
    typeof record.rethrowError !== 'boolean'
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned malformed plan');
  }
  const dispositions = [record.returnResult, record.continueQueue, record.rethrowError].filter(Boolean).length;
  if (dispositions !== 1) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid disposition cardinality');
  }
  if (record.returnResult === true && input.hasMaterializedResult !== true) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned result disposition without materialized result');
  }
  if (record.rethrowError === true && input.error === undefined) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned rethrow disposition without error input');
  }
  if (
    (record.action === 'return_result' && record.returnResult !== true) ||
    (record.action === 'continue_queue' && record.continueQueue !== true) ||
    (record.action === 'rethrow_error' && record.rethrowError !== true)
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned action/disposition mismatch');
  }
  const traceQueue =
    traceRecord.queue === 'A_optional' || traceRecord.queue === 'B_mandatory'
      ? traceRecord.queue
      : (() => {
          throw new Error('planAutoHookRuntimeAttemptJson native returned invalid queue');
        })();
  return {
    action: record.action,
    traceEvent: {
      hookId: traceRecord.hookId,
      phase: traceRecord.phase,
      priority: traceRecord.priority,
      queue: traceQueue,
      queueIndex: traceRecord.queueIndex,
      queueTotal: traceRecord.queueTotal,
      result: traceRecord.result,
      reason: traceRecord.reason,
      ...(typeof traceRecord.flowId === 'string' && traceRecord.flowId.trim()
        ? { flowId: traceRecord.flowId.trim() }
        : {})
    },
    returnResult: record.returnResult,
    continueQueue: record.continueQueue,
    rethrowError: record.rethrowError,
    ...(typeof record.errorMessage === 'string' && record.errorMessage.trim()
      ? { errorMessage: record.errorMessage.trim() }
      : {})
  };
}

function encodeAutoHookRuntimeAttemptInput(input: {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  hasPlannedResult?: boolean;
  hasMaterializedResult?: boolean;
  error?: unknown;
  materializedFlowId?: string;
}): Record<string, unknown> {
  return {
    ...input,
    error: encodeServertoolHandlerErrorCarrier(input.error)
  };
}

export function planAutoHookCallerFinalizationWithNative(input: {
  resultPresent: boolean;
  queueIndex: number;
  queueTotal: number;
}): AutoHookCallerFinalizationPlan {
  const capability = 'planAutoHookCallerFinalizationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookCallerFinalizationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planAutoHookCallerFinalizationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_result' &&
    record.action !== 'continue_next_queue' &&
    record.action !== 'return_null'
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid action');
  }
  if (
    typeof record.returnResult !== 'boolean' ||
    typeof record.continueNextQueue !== 'boolean' ||
    typeof record.returnNull !== 'boolean'
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned malformed plan');
  }
  const dispositions = [record.returnResult, record.continueNextQueue, record.returnNull].filter(Boolean).length;
  if (dispositions !== 1) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid disposition cardinality');
  }
  if (record.returnResult === true && input.resultPresent !== true) {
    throw new Error('planAutoHookCallerFinalizationJson native returned result disposition without queue result');
  }
  if (record.action === 'return_result' && record.resultMode !== 'tool_flow') {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid resultMode');
  }
  if (record.action !== 'return_result' && record.resultMode !== undefined) {
    throw new Error('planAutoHookCallerFinalizationJson native returned resultMode for non-result action');
  }
  if (
    (record.action === 'return_result' && record.returnResult !== true) ||
    (record.action === 'continue_next_queue' && record.continueNextQueue !== true) ||
    (record.action === 'return_null' && record.returnNull !== true)
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned action/disposition mismatch');
  }
  if (record.action === 'return_result') {
    return {
      action: 'return_result',
      returnResult: true,
      continueNextQueue: false,
      returnNull: false,
      resultMode: 'tool_flow'
    };
  }
  if (record.action === 'continue_next_queue') {
    return {
      action: 'continue_next_queue',
      returnResult: false,
      continueNextQueue: true,
      returnNull: false
    };
  }
  return {
    action: 'return_null',
    returnResult: false,
    continueNextQueue: false,
    returnNull: true
  };
}

export function planAutoHookCallerResultProjectionWithNative(input: {
  resultPresent: boolean;
  metadataWritePlanPresent: boolean;
}): AutoHookCallerResultProjectionPlan {
  const capability = 'planAutoHookCallerResultProjectionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookCallerResultProjectionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (resultJson instanceof Error) {
    throw resultJson;
  }
  if (
    resultJson
    && typeof resultJson === 'object'
    && 'message' in resultJson
    && typeof (resultJson as { message?: unknown }).message === 'string'
  ) {
    throw new Error((resultJson as { message: string }).message);
  }
  if (typeof resultJson !== 'string') {
    throw new Error(`planAutoHookCallerResultProjectionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planAutoHookCallerResultProjectionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.mode !== 'tool_flow') {
    throw new Error('planAutoHookCallerResultProjectionJson native returned invalid mode');
  }
  if (typeof record.includeMetadataWritePlan !== 'boolean') {
    throw new Error('planAutoHookCallerResultProjectionJson native returned malformed plan');
  }
  if (input.metadataWritePlanPresent !== true && record.includeMetadataWritePlan === true) {
    throw new Error('planAutoHookCallerResultProjectionJson native requested missing metadataWritePlan');
  }
  return {
    mode: 'tool_flow',
    includeMetadataWritePlan: record.includeMetadataWritePlan
  };
}

export function planServertoolExecutionBranchWithNative(input: {
  executableToolCalls: Array<{
    id: string;
    name: string;
    arguments?: string;
    executionMode?: string;
  }>;
  executedToolCallsLen: number;
}): ServertoolExecutionBranchPlan {
  const capability = 'planServertoolExecutionBranchJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionBranchJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionBranchJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'client_exec_cli_projection' &&
    record.action !== 'resolve_execution_outcome' &&
    record.action !== 'continue_response_stage'
  ) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid action');
  }
  if (record.projectedToolCallId !== undefined && typeof record.projectedToolCallId !== 'string') {
    throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCallId');
  }
  if (record.projectedToolCall !== undefined) {
    if (!record.projectedToolCall || typeof record.projectedToolCall !== 'object' || Array.isArray(record.projectedToolCall)) {
      throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCall');
    }
    const projected = record.projectedToolCall as Record<string, unknown>;
    if (
      typeof projected.id !== 'string' ||
      typeof projected.name !== 'string' ||
      typeof projected.arguments !== 'string'
    ) {
      throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCall');
    }
  }
  if (
    record.projectedToolCallIndex !== undefined &&
    (!Number.isInteger(record.projectedToolCallIndex) || Number(record.projectedToolCallIndex) < 0)
  ) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCallIndex');
  }
  if (record.action === 'client_exec_cli_projection' && record.projectedToolCall === undefined) {
    throw new Error('planServertoolExecutionBranchJson native returned missing projectedToolCall');
  }
  if (record.action !== 'client_exec_cli_projection') {
    return { action: record.action };
  }
  const projectedToolCall = record.projectedToolCall as ServertoolProjectedToolCall;
  return {
    action: record.action,
    projectedToolCall,
    ...(typeof record.projectedToolCallId === 'string' && record.projectedToolCallId.trim()
      ? { projectedToolCallId: record.projectedToolCallId }
      : {}),
    ...(Number.isInteger(record.projectedToolCallIndex) && Number(record.projectedToolCallIndex) >= 0
      ? { projectedToolCallIndex: Number(record.projectedToolCallIndex) }
      : {})
  };
}

export function planServertoolEnginePreflightWithNative(input: {
  hasSyntheticControlText: boolean;
  stopSignalObserved: boolean;
  stoplessDisabledOnDirectRoute?: boolean;
  adapterContext?: unknown;
}): ServertoolEnginePreflightPlan {
  const capability = 'planServertoolEnginePreflightJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEnginePreflightJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEnginePreflightJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_original_chat' &&
    record.action !== 'return_original_chat_direct_passthrough' &&
    record.action !== 'continue_to_engine'
  ) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid action');
  }
  if (typeof record.attachStopGatewayContext !== 'boolean') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid attachStopGatewayContext');
  }
  const logStopEntry = parseServertoolEnginePreflightLogStopEntry(record.logStopEntry);
  const logStopCompare = parseServertoolEnginePreflightLogStopCompare(record.logStopCompare);
  return {
    action: record.action,
    attachStopGatewayContext: record.attachStopGatewayContext,
    ...(logStopEntry ? { logStopEntry } : {}),
    ...(logStopCompare ? { logStopCompare } : {})
  };
}

export function planServertoolEngineOrchestrationPreflightActionWithNative(input: {
  preflightKind: 'return_original_chat' | 'return_original_chat_direct_passthrough' | 'continue';
}): ServertoolEngineOrchestrationPreflightActionPlan {
  const capability = 'planServertoolEngineOrchestrationPreflightActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineOrchestrationPreflightActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'return_preflight_chat' && record.action !== 'continue_engine') {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native returned invalid action');
  }
  return {
    action: record.action
  };
}

function parseServertoolEnginePreflightStage(value: unknown, field: string): 'entry' | 'trigger' {
  if (value === 'entry' || value === 'trigger') {
    return value;
  }
  throw new Error(`planServertoolEnginePreflightJson native returned invalid ${field}`);
}

function parseServertoolEnginePreflightLogStopEntry(value: unknown): ServertoolEnginePreflightPlan['logStopEntry'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.result !== 'string') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry.result');
  }
  if (typeof record.includeChoiceFacts !== 'boolean') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry.includeChoiceFacts');
  }
  return {
    stage: parseServertoolEnginePreflightStage(record.stage, 'logStopEntry.stage'),
    result: record.result,
    includeChoiceFacts: record.includeChoiceFacts
  };
}

function parseServertoolEnginePreflightLogStopCompare(value: unknown): ServertoolEnginePreflightPlan['logStopCompare'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopCompare');
  }
  const record = value as Record<string, unknown>;
  return {
    stage: parseServertoolEnginePreflightStage(record.stage, 'logStopCompare.stage')
  };
}

export function planServertoolEngineRuntimeActionWithNative(input: {
  isStopMessageFlow: boolean;
  stoplessExecutionFlowId?: string;
  stoplessAction: string;
  engineExecutionFlowId?: string;
  currentFlowId?: string;
}): ServertoolEngineRuntimeActionPlan {
  const capability = 'planServertoolEngineRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineRuntimeActionJson native unavailable');
  }
  const payload: Record<string, unknown> = {
    isStopMessageFlow: input.isStopMessageFlow,
    ...(typeof input.stoplessExecutionFlowId === 'string'
      ? { stoplessExecutionFlowId: input.stoplessExecutionFlowId }
      : {}),
    stoplessAction: input.stoplessAction,
    ...(typeof input.engineExecutionFlowId === 'string'
      ? { engineExecutionFlowId: input.engineExecutionFlowId }
      : {}),
    ...(typeof input.currentFlowId === 'string'
      ? { currentFlowId: input.currentFlowId }
      : {})
  };
  const raw = fn(JSON.stringify(payload));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_servertool_cli_projection_final' &&
    record.action !== 'return_stop_message_terminal_final' &&
    record.action !== 'build_stop_message_cli_projection'
  ) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid action');
  }
  if (record.executed !== true) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid executed flag');
  }
  if (record.flowIdSource !== 'engine_execution' && record.flowIdSource !== 'current_flow') {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid flowIdSource');
  }
  if (record.projectedFlowId != null && typeof record.projectedFlowId !== 'string') {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid projectedFlowId');
  }
  return {
    action: record.action,
    executed: true,
    flowIdSource: record.flowIdSource,
    ...(typeof record.projectedFlowId === 'string'
      ? { projectedFlowId: record.projectedFlowId }
      : {})
  };
}

export function runStoplessBuiltinHandlerForRuntimeWithNative(input: {
  name: string;
  base: JsonObject;
  requestId: string;
  runtimeMetadata?: JsonObject | null;
}): unknown {
  const capability = 'runStoplessBuiltinHandlerForRuntimeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('runStoplessBuiltinHandlerForRuntimeJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    name: input.name,
    base: input.base,
    requestId: input.requestId,
    runtimeMetadata: input.runtimeMetadata ?? null
  }));
  if (typeof raw !== 'string') {
    throw new Error(`runStoplessBuiltinHandlerForRuntimeJson native returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as unknown;
}

export function planServertoolEngineTriggerObservationWithNative(input: {
  stopSignalObserved: boolean;
  result: string;
  flowId?: string;
}): ServertoolEngineTriggerObservationPlan {
  const capability = 'planServertoolEngineTriggerObservationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineTriggerObservationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    stopSignalObserved: input.stopSignalObserved,
    result: input.result,
    ...(input.flowId !== undefined ? { flowId: input.flowId } : {})
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineTriggerObservationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.shouldLog !== 'boolean') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid shouldLog');
  }
  const logStopEntry = parseServertoolEngineTriggerLogStopEntry(record.logStopEntry);
  const logStopCompare = parseServertoolEngineTriggerLogStopCompare(record.logStopCompare);
  return {
    shouldLog: record.shouldLog,
    ...(logStopEntry ? { logStopEntry } : {}),
    ...(logStopCompare ? { logStopCompare } : {})
  };
}

function parseServertoolEngineTriggerLogStopEntry(value: unknown): ServertoolEngineTriggerObservationPlan['logStopEntry'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry');
  }
  const record = value as Record<string, unknown>;
  if (record.stage !== 'trigger') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry.stage');
  }
  if (typeof record.result !== 'string' || !record.result.trim()) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry.result');
  }
  return {
    stage: 'trigger',
    result: record.result
  };
}

function parseServertoolEngineTriggerLogStopCompare(value: unknown): ServertoolEngineTriggerObservationPlan['logStopCompare'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare');
  }
  const record = value as Record<string, unknown>;
  if (record.stage !== 'trigger') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare.stage');
  }
  if (record.flowId !== undefined && typeof record.flowId !== 'string') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare.flowId');
  }
  return {
    stage: 'trigger',
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId }
      : {})
  };
}

export function planServertoolEngineSkipWithNative(input: {
  engineMode: string;
  hasExecution: boolean;
}): ServertoolEngineSkipPlan {
  const capability = 'planServertoolEngineSkipJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineSkipJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineSkipJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineSkipJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_skipped_passthrough' &&
    record.action !== 'return_skipped_no_execution' &&
    record.action !== 'continue_matched_flow'
  ) {
    throw new Error('planServertoolEngineSkipJson native returned invalid action');
  }
  if (record.skipReason !== undefined && typeof record.skipReason !== 'string') {
    throw new Error('planServertoolEngineSkipJson native returned invalid skipReason');
  }
  if (record.action === 'return_skipped_passthrough' || record.action === 'return_skipped_no_execution') {
    if (typeof record.skipReason !== 'string' || !/\S/.test(record.skipReason)) {
      throw new Error('planServertoolEngineSkipJson native returned skipped action without skipReason');
    }
    return {
      action: record.action,
      skipReason: record.skipReason
    };
  }
  return {
    action: record.action
  };
}

export function planServertoolExecutionOutcomeRuntimeActionWithNative(input: {
  outcomeMode: string;
  hasLastExecution: boolean;
  executedToolCallsLen: number;
  lastExecution?: unknown;
  flowId?: string;
}): ServertoolExecutionOutcomeRuntimeActionPlan {
  const capability = 'planServertoolExecutionOutcomeRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionOutcomeRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionOutcomeRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionOutcomeRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'invalid_mixed_client_tools_outcome' &&
    record.action !== 'return_execution_contract' &&
    record.action !== 'missing_servertool_execution_contract'
  ) {
    throw new Error('planServertoolExecutionOutcomeRuntimeActionJson native returned invalid action');
  }
  if (typeof record.executionFlowId !== 'string') {
    throw new Error('planServertoolExecutionOutcomeRuntimeActionJson native returned invalid executionFlowId');
  }
  return {
    action: record.action,
    reuseLastExecutionEnvelope: record.reuseLastExecutionEnvelope === true,
    ...(record.selectedExecutionEnvelope !== undefined
      ? { selectedExecutionEnvelope: record.selectedExecutionEnvelope }
      : {}),
    executionFlowId: record.executionFlowId
  };
}

export function planServertoolExecutionOutcomeMaterializationWithNative(input: {
  requestId: string;
  outcomeMode: string;
  requiresPendingInjection: boolean;
  hasLastExecution: boolean;
  executedToolCallsLen: number;
  lastExecution?: unknown;
  flowId?: string;
}): ServertoolExecutionOutcomeMaterializationPlan {
  const capability = 'planServertoolExecutionOutcomeMaterializationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionOutcomeMaterializationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'throw_dispatch_error' && record.action !== 'return_tool_flow') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid action');
  }
  if (record.action === 'throw_dispatch_error') {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid errorPlan');
    }
    return {
      action: 'throw_dispatch_error',
      errorPlan: parseServertoolErrorPlan(JSON.stringify(record.errorPlan), capability)
    };
  }
  if (typeof record.executionFlowId !== 'string') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid executionFlowId');
  }
  if (record.resultMode !== 'tool_flow') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid resultMode');
  }
  return {
    action: 'return_tool_flow',
    resultMode: record.resultMode,
    executionFlowId: record.executionFlowId
  };
}

export function createServertoolProviderProtocolErrorFromPlanWithNative(
  plan: ServertoolErrorPlan
): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(plan.message, {
    code: plan.code as ProviderProtocolErrorCode,
    category: plan.category as ProviderErrorCategory,
    details: plan.details
  }) as ProviderProtocolError & { status?: number };
  err.status = plan.status;
  return err;
}

export function materializeNativeToolCallExecutionOutcomeWithNative(args: {
  baseForExecution: JsonObject;
  options: {
    requestId: string;
    adapterContext?: unknown;
  };
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  executionState: NativeServertoolExecutionLoopState;
}): NativeServertoolMaterializedEngineResult {
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputWithNative({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      adapterContext: args.options.adapterContext,
      baseForExecution: args.baseForExecution,
    })
  );

  const materializationPlan = planServertoolExecutionOutcomeMaterializationWithNative({
    requestId: args.options.requestId,
    outcomeMode: outcomePlan.outcomeMode,
    requiresPendingInjection: outcomePlan.requiresPendingInjection,
    hasLastExecution: args.executionState.lastExecution != null,
    executedToolCallsLen: args.executionState.executedToolCalls.length,
    lastExecution: args.executionState.lastExecution,
    flowId: outcomePlan.flowId
  });

  switch (materializationPlan.action) {
    case 'throw_dispatch_error':
      throw createServertoolProviderProtocolErrorFromPlanWithNative(materializationPlan.errorPlan);
    case 'return_tool_flow':
      return {
        mode: materializationPlan.resultMode,
        finalChatResponse: args.baseForExecution,
        execution: {
          flowId: materializationPlan.executionFlowId
        }
      };
    default:
      throw new Error('[servertool] invalid execution outcome materialization action');
  }
}

export function planServertoolExecutionLoopRuntimeActionWithNative(input: {
  hasHandlerEntry: boolean;
  triggerMode?: string;
  nativeExecutionMode?: string;
  tsExecutionMode?: string;
  hasMaterializedResult: boolean;
  hasHandlerError: boolean;
}): ServertoolExecutionLoopRuntimeActionPlan {
  const capability = 'planServertoolExecutionLoopRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionLoopRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'skip_non_tool_call_handler' &&
    record.action !== 'throw_dispatch_spec_mismatch' &&
    record.action !== 'apply_materialized_result' &&
    record.action !== 'apply_handler_error_tool_output' &&
    record.action !== 'continue_without_effect'
  ) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native returned invalid action');
  }
  return {
    action: record.action
  };
}

export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: 'handler_error';
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopFlowId?: string;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopHandlerErrorEffectPlan;
export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: string;
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopFlowId?: string;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopEffectBasePlan;
export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: string;
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopFlowId?: string;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopEffectPlan {
  const capability = 'planServertoolExecutionLoopEffectJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionLoopEffectJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionLoopEffectJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.toolCall || typeof record.toolCall !== 'object' || Array.isArray(record.toolCall)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid toolCall');
  }
  if (!record.execution || typeof record.execution !== 'object' || Array.isArray(record.execution)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid execution');
  }
  const toolCall = record.toolCall as Record<string, unknown>;
  const execution = record.execution as Record<string, unknown>;
  if (typeof toolCall.id !== 'string' || typeof toolCall.name !== 'string' || typeof toolCall.arguments !== 'string') {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid toolCall shape');
  }
  if (typeof execution.flowId !== 'string') {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid execution flowId');
  }
  const basePlan = {
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      executionMode: typeof toolCall.executionMode === 'string' ? toolCall.executionMode : '',
      stripAfterExecute: typeof toolCall.stripAfterExecute === 'boolean' ? toolCall.stripAfterExecute : false
    },
    execution: {
      flowId: execution.flowId
    }
  };
  if (input.mode === 'handler_error') {
    if (typeof record.handlerErrorMessage !== 'string') {
      throw new Error('planServertoolExecutionLoopEffectJson native returned handler_error without handlerErrorMessage');
    }
    return {
      ...basePlan,
      handlerErrorMessage: record.handlerErrorMessage
    };
  }
  return basePlan;
}

function encodeServertoolExecutionLoopEffectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { handlerErrorMessage: input };
  }
  const record = input as Record<string, unknown>;
  return {
    ...record,
    handlerErrorMessage: encodeServertoolHandlerErrorCarrier(record.handlerErrorMessage)
  };
}

function encodeServertoolHandlerErrorCarrier(error: unknown): unknown {
  if (error instanceof Error) {
    return { message: error.message };
  }
  return error;
}

export function planServertoolResponseStageRuntimeActionWithNative(input: {
  responseStageGatePlan?: unknown;
  responseStageNextAction?: string;
  baseObject?: JsonObject;
  autoHookEvaluated: boolean;
  hasAutoHookResult: boolean;
}): ServertoolResponseStageRuntimeActionPlan {
  const capability = 'planServertoolResponseStageRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_passthrough_bypass' &&
    record.action !== 'run_auto_hooks' &&
    record.action !== 'return_auto_hook_result' &&
    record.action !== 'return_required_response_hook_empty' &&
    record.action !== 'return_passthrough_no_auto_hook_result'
  ) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid action');
  }
  if (record.action === 'return_auto_hook_result' && input.hasAutoHookResult !== true) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned return_auto_hook_result without auto-hook result');
  }
  const isPassthroughAction =
    record.action === 'return_passthrough_bypass' ||
    record.action === 'return_passthrough_no_auto_hook_result';
  if (isPassthroughAction && record.resultMode !== undefined) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned deprecated resultMode for passthrough action');
  }
  const skipReason =
    typeof record.skipReason === 'string' && record.skipReason
      ? record.skipReason
      : undefined;
  if (record.action === 'return_passthrough_bypass' && record.skipReason !== undefined && !skipReason) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned empty bypass skipReason');
  }
  if (!isPassthroughAction && record.resultMode !== undefined) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned resultMode for non-passthrough action');
  }
  if (record.action === 'return_passthrough_bypass' || record.action === 'return_passthrough_no_auto_hook_result') {
    if (!record.passthroughResult || typeof record.passthroughResult !== 'object' || Array.isArray(record.passthroughResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthrough action without passthroughResult');
    }
    const passthroughResult = record.passthroughResult as Record<string, unknown>;
    if (passthroughResult.mode !== 'passthrough') {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid passthroughResult mode');
    }
    if (!Object.prototype.hasOwnProperty.call(passthroughResult, 'finalChatResponse')) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthroughResult without finalChatResponse');
    }
    return {
      action: record.action,
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: passthroughResult.finalChatResponse
      },
      ...(skipReason ? { skipReason } : {})
    };
  }
  if (record.action === 'return_required_response_hook_empty') {
    if (typeof record.responseHookName !== 'string' || !record.responseHookName) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned required hook empty without responseHookName');
    }
    return {
      action: 'return_required_response_hook_empty',
      responseHookName: record.responseHookName
    };
  }
  if (record.action === 'run_auto_hooks' || record.action === 'return_auto_hook_result') {
    return {
      action: record.action
    };
  }
  throw new Error('planServertoolResponseStageRuntimeActionJson native returned unhandled action');
}

export function planServertoolResponseStageOrchestrationOutputWithNative(input: {
  orchestrationExecuted: boolean;
  orchestrationFlowId?: string;
}): ServertoolResponseStageOrchestrationOutputPlan {
  const capability = 'planServertoolResponseStageOrchestrationOutputJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageOrchestrationOutputJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.returnAction !== 'return_executed_payload' &&
    record.returnAction !== 'return_original_payload'
  ) {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native returned invalid returnAction');
  }
  if (typeof record.recordExecuted !== 'boolean') {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native returned invalid recordExecuted');
  }
  if (record.recordFlowId !== undefined && typeof record.recordFlowId !== 'string') {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native returned invalid recordFlowId');
  }
  if (record.returnAction === 'return_executed_payload' && record.recordExecuted !== true) {
    throw new Error('planServertoolResponseStageOrchestrationOutputJson native returned executed payload without executed record');
  }
  return {
    returnAction: record.returnAction,
    recordExecuted: record.recordExecuted,
    ...(typeof record.recordFlowId === 'string' && record.recordFlowId.trim()
      ? { recordFlowId: record.recordFlowId.trim() }
      : {})
  };
}

export function materializeServertoolResponseStageOrchestrationOutputWithNative(input: {
  originalPayload: JsonObject;
  executedPayload: JsonObject;
  orchestrationExecuted: boolean;
  orchestrationFlowId?: string;
}): ServertoolResponseStageOrchestrationMaterializedOutput {
  const capability = 'materializeServertoolResponseStageOrchestrationOutputJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`materializeServertoolResponseStageOrchestrationOutputJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid output');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid payload');
  }
  if (typeof record.executed !== 'boolean') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid executed flag');
  }
  if (record.flowId !== undefined && typeof record.flowId !== 'string') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid flowId');
  }
  if (typeof record.returnedExecutedPayload !== 'boolean') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid returnedExecutedPayload flag');
  }
  if (record.returnedExecutedPayload && record.executed !== true) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned executed payload without executed record');
  }
  return {
    payload: record.payload as JsonObject,
    executed: record.executed,
    returnedExecutedPayload: record.returnedExecutedPayload,
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId.trim() }
      : {})
  };
}

export function planServertoolEntryPreflightWithNative(input: {
  hasBaseObject: boolean;
  adapterClientDisconnected: boolean;
  chatResponse: unknown;
}): ServertoolEntryPreflightPlan {
  const capability = 'planServertoolEntryPreflightJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryPreflightJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    hasBaseObject: input.hasBaseObject,
    adapterClientDisconnected: input.adapterClientDisconnected,
    chatResponse: input.chatResponse
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEntryPreflightJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEntryPreflightJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_passthrough_non_object_chat' &&
    record.action !== 'throw_client_disconnected' &&
    record.action !== 'continue_to_tool_flow'
  ) {
    throw new Error('planServertoolEntryPreflightJson native returned invalid action');
  }
  if (record.action === 'return_passthrough_non_object_chat') {
    if (record.resultMode !== 'passthrough') {
      throw new Error('planServertoolEntryPreflightJson native returned passthrough action without passthrough resultMode');
    }
    if (!record.passthroughResult || typeof record.passthroughResult !== 'object' || Array.isArray(record.passthroughResult)) {
      throw new Error('planServertoolEntryPreflightJson native returned invalid passthroughResult');
    }
    const passthroughResult = record.passthroughResult as Record<string, unknown>;
    if (passthroughResult.mode !== 'passthrough') {
      throw new Error('planServertoolEntryPreflightJson native returned invalid passthroughResult.mode');
    }
    return {
      action: 'return_passthrough_non_object_chat',
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: passthroughResult.finalChatResponse
      }
    };
  }
  if (record.resultMode !== undefined) {
    throw new Error('planServertoolEntryPreflightJson native returned resultMode for non-passthrough action');
  }
  if (record.passthroughResult !== undefined) {
    throw new Error('planServertoolEntryPreflightJson native returned passthroughResult for non-passthrough action');
  }
  return {
    action: record.action
  };
}

export function readServertoolEntryBaseObjectWithNative(chatResponse: unknown): JsonObject | null {
  if (chatResponse == null || typeof chatResponse !== 'object' || Array.isArray(chatResponse)) {
    return null;
  }
  return chatResponse as JsonObject;
}

export interface ServertoolEntryContextPlan {
  includeToolCallNames?: string[];
  excludeToolCallNames?: string[];
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}

export interface ServertoolEnginePrepassActionPlan {
  action: 'return_prepass_result' | 'continue_to_execution';
}

export function planServertoolEntryContextWithNative(input: {
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}): ServertoolEntryContextPlan {
  const capability = 'planServertoolEntryContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEntryContextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEntryContextJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of [
    'includeToolCallNames',
    'excludeToolCallNames',
    'includeAutoHookIds',
    'excludeAutoHookIds'
  ]) {
    const value = record[key];
    if (value != null && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
      throw new Error(`planServertoolEntryContextJson native returned invalid ${key}`);
    }
  }
  return {
    includeToolCallNames: record.includeToolCallNames == null ? undefined : record.includeToolCallNames as string[],
    excludeToolCallNames: record.excludeToolCallNames == null ? undefined : record.excludeToolCallNames as string[],
    includeAutoHookIds: record.includeAutoHookIds == null ? undefined : record.includeAutoHookIds as string[],
    excludeAutoHookIds: record.excludeAutoHookIds == null ? undefined : record.excludeAutoHookIds as string[]
  };
}

export function planServertoolEnginePrepassActionWithNative(input: {
  hasPrepassResult: boolean;
}): ServertoolEnginePrepassActionPlan {
  const capability = 'planServertoolEnginePrepassActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEnginePrepassActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEnginePrepassActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEnginePrepassActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_prepass_result' &&
    record.action !== 'continue_to_execution'
  ) {
    throw new Error('planServertoolEnginePrepassActionJson native returned invalid action');
  }
  return {
    action: record.action
  };
}

export type ServertoolRegistryLookupActionPlan = {
  action: 'return_builtin' | 'return_none';
  canonicalName?: string;
};

export function planServertoolRegistryLookupActionWithNative(input: {
  name: string;
  builtinEntryPresent: boolean;
}): ServertoolRegistryLookupActionPlan {
  const capability = 'planServertoolRegistryLookupActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistryLookupActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistryLookupActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRegistryLookupActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_builtin' &&
    record.action !== 'return_none'
  ) {
    throw new Error('planServertoolRegistryLookupActionJson native returned invalid action');
  }
  if (record.canonicalName !== undefined && typeof record.canonicalName !== 'string') {
    throw new Error('planServertoolRegistryLookupActionJson native returned invalid canonicalName');
  }
  return {
    action: record.action,
    ...(typeof record.canonicalName === 'string' && record.canonicalName.trim()
      ? { canonicalName: record.canonicalName }
      : {})
  };
}

export type ServertoolRegistryAutoHookDescriptorPlan = {
  id: string;
  phase: 'pre' | 'default' | 'post';
  priority: number;
  order: number;
  sourceIndex: number;
};

export type ServertoolRegistryBuiltinAutoHookEntryPlan = {
  id: string;
  phase: 'pre' | 'default' | 'post';
  priority: number;
  order: number;
  registration: Record<string, unknown>;
  execution: Record<string, unknown>;
};

export function planServertoolRegistryAutoHookDescriptorsWithNative(input: {
  hooks: Array<{
    id: string;
    phase?: string;
    priority?: number;
    order?: number;
  }>;
}): ServertoolRegistryAutoHookDescriptorPlan[] {
  const capability = 'planServertoolRegistryAutoHookDescriptorsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistryAutoHookDescriptorsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input.hooks));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistryAutoHookDescriptorsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid plan');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid descriptor');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid id');
    }
    if (record.phase !== 'pre' && record.phase !== 'default' && record.phase !== 'post') {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid phase');
    }
    if (typeof record.priority !== 'number' || !Number.isFinite(record.priority)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid priority');
    }
    if (typeof record.order !== 'number' || !Number.isFinite(record.order)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid order');
    }
    if (
      typeof record.sourceIndex !== 'number' ||
      !Number.isInteger(record.sourceIndex) ||
      record.sourceIndex < 0
    ) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid sourceIndex');
    }
    return {
      id: record.id,
      phase: record.phase,
      priority: record.priority,
      order: record.order,
      sourceIndex: record.sourceIndex
    };
  });
}

export function planServertoolRegistryBuiltinAutoHookEntriesWithNative(input: {
  hooks: Array<{
    id: string;
    phase?: string;
    priority?: number;
    order?: number;
    registration: Record<string, unknown>;
    execution: Record<string, unknown>;
  }>;
}): ServertoolRegistryBuiltinAutoHookEntryPlan[] {
  const descriptors = planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: input.hooks.map((hook) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
    })),
  });
  return descriptors.map((descriptor) => {
    const source = input.hooks[descriptor.sourceIndex];
    if (!source || typeof source !== 'object') {
      throw new Error(
        `planServertoolRegistryAutoHookDescriptorsJson native returned descriptor without builtin hook sourceIndex: ${descriptor.sourceIndex}`
      );
    }
    return {
      id: descriptor.id,
      phase: descriptor.phase,
      priority: descriptor.priority,
      order: descriptor.order,
      registration: source.registration,
      execution: source.execution,
    };
  });
}

export type ServertoolRegistryProjectionRecordPlan = {
  name: string;
  trigger: 'tool_call' | 'auto';
  sourceIndex: number;
};

export type ServertoolRegistryProjectionPlan = {
  registeredNames: string[];
  registeredRecords: ServertoolRegistryProjectionRecordPlan[];
  autoHandlerNames: string[];
};

export type ServertoolRegistrySourceKind = 'builtin';

export type ServertoolRegistrySourceRefPlan = {
  name: string;
  source: ServertoolRegistrySourceKind;
  sourceIndex: number;
};

export type ServertoolRegistrySourceRecordRefPlan = ServertoolRegistrySourceRefPlan & {
  trigger: 'tool_call' | 'auto';
};

export type ServertoolRegistrySourceProjectionPlan = {
  registeredNames: string[];
  autoHandlerRefs: ServertoolRegistrySourceRefPlan[];
  registeredRecordRefs: ServertoolRegistrySourceRecordRefPlan[];
};

export function planServertoolRegistryProjectionWithNative(input: {
  registeredNames: string[];
  registeredRecords: Array<{
    name: string;
    trigger: string;
    sourceIndex: number;
  }>;
  autoHandlerNames: string[];
}): ServertoolRegistryProjectionPlan {
  const capability = 'planServertoolRegistryProjectionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistryProjectionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistryProjectionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRegistryProjectionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.registeredNames) ||
    !Array.isArray(record.registeredRecords) ||
    !Array.isArray(record.autoHandlerNames)
  ) {
    throw new Error('planServertoolRegistryProjectionJson native returned invalid plan arrays');
  }
  return {
    registeredNames: record.registeredNames.map((name) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid registered name');
      }
      return name;
    }),
    registeredRecords: record.registeredRecords.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid registered record');
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid registered record name');
      }
      if (item.trigger !== 'tool_call' && item.trigger !== 'auto') {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid registered record trigger');
      }
      if (
        typeof item.sourceIndex !== 'number' ||
        !Number.isInteger(item.sourceIndex) ||
        (item.sourceIndex as number) < 0
      ) {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid sourceIndex');
      }
      return {
        name: item.name,
        trigger: item.trigger,
        sourceIndex: item.sourceIndex
      };
    }),
    autoHandlerNames: record.autoHandlerNames.map((name) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('planServertoolRegistryProjectionJson native returned invalid auto handler name');
      }
      return name;
    })
  };
}

function parseServertoolRegistrySource(value: unknown, capability: string): ServertoolRegistrySourceKind {
  if (value !== 'builtin') {
    throw new Error(`${capability} native returned invalid source`);
  }
  return value;
}

function parseServertoolRegistrySourceIndex(value: unknown, capability: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${capability} native returned invalid sourceIndex`);
  }
  return value;
}

export function planServertoolRegistrySourceProjectionWithNative(input: {
  builtinNames: string[];
  builtinAutoHandlerNames: string[];
  builtinRecords: Array<{
    name: string;
    trigger: string;
  }>;
}): ServertoolRegistrySourceProjectionPlan {
  const capability = 'planServertoolRegistrySourceProjectionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistrySourceProjectionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistrySourceProjectionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.registeredNames) ||
    !Array.isArray(record.autoHandlerRefs) ||
    !Array.isArray(record.registeredRecordRefs)
  ) {
    throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid plan arrays');
  }
  return {
    registeredNames: record.registeredNames.map((name) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid registered name');
      }
      return name;
    }),
    autoHandlerRefs: record.autoHandlerRefs.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid auto handler ref');
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid auto handler name');
      }
      return {
        name: item.name,
        source: parseServertoolRegistrySource(item.source, 'planServertoolRegistrySourceProjectionJson'),
        sourceIndex: parseServertoolRegistrySourceIndex(item.sourceIndex, 'planServertoolRegistrySourceProjectionJson')
      };
    }),
    registeredRecordRefs: record.registeredRecordRefs.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid registered record ref');
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid registered record name');
      }
      if (item.trigger !== 'tool_call' && item.trigger !== 'auto') {
        throw new Error('planServertoolRegistrySourceProjectionJson native returned invalid registered record trigger');
      }
      return {
        name: item.name,
        trigger: item.trigger,
        source: parseServertoolRegistrySource(item.source, 'planServertoolRegistrySourceProjectionJson'),
        sourceIndex: parseServertoolRegistrySourceIndex(item.sourceIndex, 'planServertoolRegistrySourceProjectionJson')
      };
    })
  };
}

export function planServertoolHandlerMaterializationWithNative(input: {
  requestId: string;
  hasFinalizeFunction: boolean;
  hasChatResponseObject: boolean;
  hasExecutionObject: boolean;
  hasExecutionFlowId: boolean;
  hasPlanMarkers: boolean;
}): ServertoolHandlerMaterializationPlan {
  const capability = 'planServertoolHandlerMaterializationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolHandlerMaterializationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolHandlerMaterializationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolHandlerMaterializationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'finalize_without_backend' &&
    record.action !== 'return_handler_result' &&
    record.action !== 'throw_handler_error'
  ) {
    throw new Error('planServertoolHandlerMaterializationJson native returned invalid action');
  }
  if (record.action === 'throw_handler_error') {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolHandlerMaterializationJson native returned invalid errorPlan');
    }
    return {
      action: 'throw_handler_error',
      errorPlan: parseServertoolErrorPlan(JSON.stringify(record.errorPlan), capability)
    };
  }
  return { action: record.action };
}

export function planServertoolHandlerMaterializationForPlannedWithNative(
  planned: unknown,
  requestId: string
): ServertoolHandlerMaterializationPlan {
  const record =
    planned && typeof planned === 'object' && !Array.isArray(planned)
      ? (planned as Record<string, unknown>)
      : {};
  const execution =
    record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
      ? (record.execution as Record<string, unknown>)
      : undefined;
  return planServertoolHandlerMaterializationWithNative({
    requestId,
    hasFinalizeFunction: typeof record.finalize === 'function',
    hasChatResponseObject: Boolean(record.chatResponse && typeof record.chatResponse === 'object' && !Array.isArray(record.chatResponse)),
    hasExecutionObject: Boolean(record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)),
    hasExecutionFlowId: typeof execution?.flowId === 'string',
    hasPlanMarkers: typeof record.flowId === 'string' || record.finalize !== undefined
  });
}

export function materializeServertoolHandlerResultWithNative(
  planned: unknown,
  requestId: string
): NativeServerToolHandlerResult {
  const plan = planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId);
  if (plan.action === 'throw_handler_error') {
    throw new Error(plan.errorPlan.message);
  }
  if (plan.action !== 'return_handler_result') {
    throw new Error('[servertool] invalid handler materialization plan result');
  }
  const record = planned as Record<string, unknown>;
  return {
    chatResponse: record.chatResponse as JsonObject,
    execution: record.execution as NativeServerToolExecution,
    ...(record.metadataWritePlan != null
      ? { metadataWritePlan: record.metadataWritePlan as JsonObject }
      : {})
  };
}

export async function finalizeServertoolHandlerPlanWithNative(
  planned: unknown,
  requestId: string
): Promise<NativeServerToolHandlerResult | null> {
  const plan = planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId);
  if (plan.action === 'throw_handler_error') {
    throw new Error(plan.errorPlan.message);
  }
  if (plan.action !== 'finalize_without_backend') {
    throw new Error('[servertool] invalid handler materialization plan without finalize');
  }
  return await (planned as { finalize: () => Promise<NativeServerToolHandlerResult | null> }).finalize();
}

export const materializeServertoolPlannedResultWithNative = async (
  planned: unknown,
  options: { requestId: string }
): Promise<NativeServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerMaterializationForPlannedWithNative(
    planned,
    options.requestId
  );
  switch (actionPlan.action) {
    case 'finalize_without_backend': {
      return await finalizeServertoolHandlerPlanWithNative(planned, options.requestId);
    }
    case 'throw_handler_error':
      throw createServertoolProviderProtocolErrorFromPlanWithNative(actionPlan.errorPlan);
    case 'return_handler_result':
      return materializeServertoolHandlerResultWithNative(planned, options.requestId);
    default:
      throw new Error('[servertool] invalid handler materialization action');
  }
};

export function planEngineSelectionStartWithNative(input: {
  primaryAutoHookIds: string[];
}): EngineSelectionStartPlan {
  const capability = 'planEngineSelectionStartJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planEngineSelectionStartJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planEngineSelectionStartJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planEngineSelectionStartJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'run_default' && record.action !== 'run_primary_hooks') {
    throw new Error('planEngineSelectionStartJson native returned invalid action');
  }
  if (!Array.isArray(record.primaryAutoHookIds)) {
    throw new Error('planEngineSelectionStartJson native returned invalid primaryAutoHookIds');
  }
  return {
    action: record.action,
    overrides: parseEngineSelectionOverridesPlan(record.overrides, capability),
    primaryAutoHookIds: record.primaryAutoHookIds.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('planEngineSelectionStartJson native returned invalid primaryAutoHookIds item');
      }
      return item.trim();
    })
  };
}

export function planEngineSelectionAfterRunWithNative(input: {
  primaryAutoHookIds: string[];
  engineResult: unknown;
}): EngineSelectionAfterRunPlan {
  const capability = 'planEngineSelectionAfterRunJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planEngineSelectionAfterRunJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planEngineSelectionAfterRunJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planEngineSelectionAfterRunJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'rerun_excluding_primary_hooks' && record.action !== 'return_current') {
    throw new Error('planEngineSelectionAfterRunJson native returned invalid action');
  }
  if (record.action === 'rerun_excluding_primary_hooks') {
    return {
      action: record.action,
      overrides: parseEngineSelectionOverridesPlan(record.overrides, capability)
    };
  }
  if (record.overrides !== undefined && record.overrides !== null) {
    throw new Error('planEngineSelectionAfterRunJson native returned overrides for return_current action');
  }
  return { action: record.action };
}

function parseEngineSelectionOverridesPlan(value: unknown, capability: string): EngineSelectionOverridesPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid overrides`);
  }
  const record = value as Record<string, unknown>;
  const includeAutoHookIds = parseOptionalStringArray(record.includeAutoHookIds, capability, 'includeAutoHookIds');
  const excludeAutoHookIds = parseOptionalStringArray(record.excludeAutoHookIds, capability, 'excludeAutoHookIds');
  if (record.disableToolCallHandlers !== undefined && typeof record.disableToolCallHandlers !== 'boolean') {
    throw new Error(`${capability} native returned invalid disableToolCallHandlers`);
  }
  return {
    ...(typeof record.disableToolCallHandlers === 'boolean'
      ? { disableToolCallHandlers: record.disableToolCallHandlers }
      : {}),
    ...(includeAutoHookIds ? { includeAutoHookIds } : {}),
    ...(excludeAutoHookIds ? { excludeAutoHookIds } : {})
  };
}

function parseOptionalStringArray(value: unknown, capability: string, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid ${field}`);
  }
  const output = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${capability} native returned invalid ${field} item`);
    }
    return item.trim();
  });
  return output.length > 0 ? output : undefined;
}

function parseAutoHookTraceEventPlan(value: unknown, capability: string): AutoHookTraceEventPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid traceEvent`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.hookId !== 'string' ||
    typeof record.phase !== 'string' ||
    typeof record.priority !== 'number' ||
    typeof record.queue !== 'string' ||
    typeof record.queueIndex !== 'number' ||
    typeof record.queueTotal !== 'number' ||
    (record.result !== 'miss' && record.result !== 'match' && record.result !== 'error') ||
    typeof record.reason !== 'string'
  ) {
    throw new Error(`${capability} native returned malformed traceEvent`);
  }
  const traceQueue =
    record.queue === 'A_optional' || record.queue === 'B_mandatory'
      ? record.queue
      : (() => {
          throw new Error(`${capability} native returned invalid queue`);
        })();
  return {
    hookId: record.hookId,
    phase: record.phase,
    priority: record.priority,
    queue: traceQueue,
    queueIndex: record.queueIndex,
    queueTotal: record.queueTotal,
    result: record.result,
    reason: record.reason,
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId.trim() }
      : {})
  };
}

export function resolveDefaultStopMessageSnapshotWithNative(
  input: StopMessageDefaultSnapshotInput,
): RuntimeStopMessageStateSnapshot | null {
  const capability = 'resolveDefaultStopMessageSnapshotJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveDefaultStopMessageSnapshotJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveDefaultStopMessageSnapshotJson native returned non-string: ${typeof resultJson}`);
  }
  return parseRuntimeStopMessageStateSnapshotPayload(resultJson, capability);
}

export function resolveImplicitGeminiStopMessageSnapshotWithNative(
  input: StopMessageImplicitGeminiSnapshotInput,
): RuntimeStopMessageStateSnapshot | null {
  const capability = 'resolveImplicitGeminiStopMessageSnapshotJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveImplicitGeminiStopMessageSnapshotJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveImplicitGeminiStopMessageSnapshotJson native returned non-string: ${typeof resultJson}`);
  }
  return parseRuntimeStopMessageStateSnapshotPayload(resultJson, capability);
}

export function readServertoolLoopStateWithNative(runtimeMetadata: unknown): ServertoolLoopStateSnapshot | null {
  const capability = 'readServertoolLoopStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('readServertoolLoopStateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(runtimeMetadata ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`readServertoolLoopStateJson native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolLoopStatePayload(resultJson, capability);
}

export function planServertoolLoopStateWithNative(
  input: ServertoolLoopStatePlanInput,
): ServertoolLoopStateSnapshot | null {
  const capability = 'planServertoolLoopStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolLoopStateJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolLoopStateJson native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolLoopStatePayload(resultJson, capability);
}

function parseServertoolLoopStatePayload(resultJson: string, capability: string): ServertoolLoopStateSnapshot | null {
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.payloadHash !== 'string' || !record.payloadHash.trim()) {
    throw new Error(`${capability} native returned invalid payloadHash`);
  }
  return {
    ...(typeof record.flowId === 'string' && record.flowId.trim() ? { flowId: record.flowId.trim() } : {}),
    payloadHash: record.payloadHash.trim(),
    ...(Number.isInteger(record.repeatCount) ? { repeatCount: record.repeatCount as number } : {}),
    ...(Number.isInteger(record.startedAtMs) ? { startedAtMs: record.startedAtMs as number } : {}),
    ...(typeof record.stopPairHash === 'string' && record.stopPairHash.trim() ? { stopPairHash: record.stopPairHash.trim() } : {}),
    ...(Number.isInteger(record.stopPairRepeatCount) ? { stopPairRepeatCount: record.stopPairRepeatCount as number } : {}),
    ...(typeof record.stopPairWarned === 'boolean' ? { stopPairWarned: record.stopPairWarned } : {})
  };
}

export function parseServertoolTimeoutMsWithNative(input: ServertoolTimeoutPolicyInput): number {
  const capability = 'parseServertoolTimeoutMsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('parseServertoolTimeoutMsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`parseServertoolTimeoutMsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new Error('parseServertoolTimeoutMsJson native returned invalid timeout');
  }
  if (parsed < 0) {
    throw new Error('parseServertoolTimeoutMsJson native returned invalid timeout');
  }
  return parsed;
}

export function resolveServertoolTimeoutMsFromEnvCandidatesWithNative(input: {
  candidates: Array<{ key: string; value?: unknown }>;
}): number {
  const capability = 'resolveServertoolTimeoutMsFromEnvCandidatesJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveServertoolTimeoutMsFromEnvCandidatesJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveServertoolTimeoutMsFromEnvCandidatesJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error('resolveServertoolTimeoutMsFromEnvCandidatesJson native returned invalid timeout');
  }
  return parsed;
}

export function planServertoolTimeoutWatcherWithNative(timeoutMs: unknown): ServertoolTimeoutWatcherPlan {
  const capability = 'planServertoolTimeoutWatcherJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolTimeoutWatcherJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ timeoutMs }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolTimeoutWatcherJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolTimeoutWatcherJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.armed !== 'boolean' || !Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 0) {
    throw new Error('planServertoolTimeoutWatcherJson native returned invalid plan');
  }
  return { armed: record.armed, timeoutMs: record.timeoutMs as number };
}

export function isAdapterClientDisconnectedWithNative(adapterContext: unknown): boolean {
  const capability = 'isAdapterClientDisconnectedJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('isAdapterClientDisconnectedJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(adapterContext ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`isAdapterClientDisconnectedJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`isAdapterClientDisconnectedJson native returned invalid bool: ${resultJson}`);
}

export function planClientDisconnectWatcherWithNative(pollIntervalMs: unknown): ServertoolClientDisconnectWatcherPlan {
  const capability = 'planClientDisconnectWatcherJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planClientDisconnectWatcherJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ pollIntervalMs }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planClientDisconnectWatcherJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planClientDisconnectWatcherJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.intervalMs) || (record.intervalMs as number) <= 0) {
    throw new Error('planClientDisconnectWatcherJson native returned invalid interval');
  }
  return { intervalMs: record.intervalMs as number };
}

export function planServertoolClientDisconnectedErrorWithNative(input: {
  requestId: string;
  flowId?: string;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolClientDisconnectedErrorJson', input),
    'planServertoolClientDisconnectedErrorJson'
  );
}

export function planServertoolTimeoutErrorWithNative(input: {
  requestId: string;
  phase: 'engine' | 'followup';
  timeoutMs: unknown;
  flowId?: string;
  attempt?: unknown;
  maxAttempts?: unknown;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolTimeoutErrorJson', input),
    'planServertoolTimeoutErrorJson'
  );
}

export function planServertoolStateLoadFailedErrorWithNative(input: {
  requestId: string;
  stickyKey: string;
  entryEndpoint: string;
  providerProtocol: string;
  error: string;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolStateLoadFailedErrorJson', input),
    'planServertoolStateLoadFailedErrorJson'
  );
}

export function planServertoolRequiredResponseHookEmptyErrorWithNative(input: {
  requestId: string;
  responseHookName: string;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolRequiredResponseHookEmptyErrorJson', input),
    'planServertoolRequiredResponseHookEmptyErrorJson'
  );
}

export function planServertoolExecutionDispatchErrorWithNative(input:
  | {
      kind: 'dispatch_spec_mismatch';
      requestId: string;
      toolName: string;
      nativeExecutionMode: string;
      tsExecutionMode: string;
    }
  | {
      kind: 'invalid_mixed_client_tools_outcome';
      requestId: string;
      outcomeMode: string;
      requiresPendingInjection: boolean;
    }
  | {
      kind: 'missing_servertool_execution_contract';
      requestId: string;
      outcomeMode: string;
    }
): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolExecutionDispatchErrorJson', input),
    'planServertoolExecutionDispatchErrorJson'
  );
}

export function buildServertoolPostflightObservationSummaryWithNative(input: {
  engineResult: unknown;
}): Record<string, unknown> {
  const capability = 'buildServertoolPostflightObservationSummaryJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildServertoolPostflightObservationSummaryJson native unavailable');
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw !== 'string') {
    throw new Error(`buildServertoolPostflightObservationSummaryJson native returned non-string: ${typeof raw}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildServertoolPostflightObservationSummaryJson native returned invalid summary');
  }
  return parsed as Record<string, unknown>;
}

export function createServertoolExecutionLoopStateWithNative(): NativeServertoolExecutionLoopState {
  const capability = 'createServertoolExecutionLoopStateJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const resultJson = fn();
  if (typeof resultJson !== 'string') {
    throw new Error(`${capability} native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolExecutionLoopState(resultJson, capability);
}

export function appendServertoolExecutedRecordWithNative(input: {
  state?: NativeServertoolExecutionLoopState;
  toolCall: NativeServertoolExecutedToolCall;
  execution?: NativeServertoolExecutionSummary;
}): NativeServertoolExecutionLoopState {
  const capability = 'appendServertoolExecutedRecordJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`${capability} native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolExecutionLoopState(resultJson, capability);
}

export function planStopMessageFetchFailedErrorWithNative(input: {
  requestId: string;
  reason: 'loop_limit';
  elapsedMs?: unknown;
  repeatCount?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planStopMessageFetchFailedErrorJson', input),
    'planStopMessageFetchFailedErrorJson'
  );
}

function callServertoolErrorPlanNative(capability: string, input: unknown): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`${capability} native returned non-string: ${typeof resultJson}`);
  }
  return resultJson;
}

function parseServertoolErrorPlan(resultJson: string, capability: string): ServertoolErrorPlan {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid error plan`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.message !== 'string' ||
    typeof record.code !== 'string' ||
    typeof record.category !== 'string' ||
    !Number.isInteger(record.status) ||
    !record.details ||
    typeof record.details !== 'object' ||
    Array.isArray(record.details)
  ) {
    throw new Error(`${capability} native returned invalid error plan`);
  }
  return {
    message: record.message,
    code: record.code,
    category: record.category,
    status: record.status as number,
    details: record.details as Record<string, unknown>
  };
}

function parseServertoolExecutionLoopState(
  resultJson: string,
  capability: string
): NativeServertoolExecutionLoopState {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid execution state`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.executedToolCalls) ||
    !Array.isArray(record.executedIds) ||
    !Array.isArray(record.executedFlowIds)
  ) {
    throw new Error(`${capability} native returned malformed execution state`);
  }
  return {
    executedToolCalls: record.executedToolCalls as NativeServertoolExecutedRecord[],
    executedIds: record.executedIds.map((value) => String(value)),
    executedFlowIds: record.executedFlowIds.map((value) => String(value)),
    ...(record.lastExecution && typeof record.lastExecution === 'object' && !Array.isArray(record.lastExecution)
      ? { lastExecution: record.lastExecution as NativeServertoolExecutionSummary }
      : {})
  };
}

export function readClientInjectOnlyWithNative(metadata: Record<string, unknown>): boolean {
  const capability = 'readClientInjectOnlyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('readClientInjectOnlyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(metadata));
  if (typeof resultJson !== 'string') {
    throw new Error(`readClientInjectOnlyJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`readClientInjectOnlyJson native returned invalid bool: ${resultJson}`);
}

export function normalizeClientInjectTextWithNative(value: unknown): string {
  const capability = 'normalizeClientInjectTextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('normalizeClientInjectTextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ value }));
  if (typeof resultJson !== 'string') {
    throw new Error(`normalizeClientInjectTextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'string' || !parsed.trim()) {
    throw new Error('normalizeClientInjectTextJson native returned invalid text');
  }
  return parsed;
}

export function compactFollowupErrorReasonWithNative(value: unknown): string | undefined {
  const capability = 'compactFollowupErrorReasonJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('compactFollowupErrorReasonJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(value ?? null));
  if (typeof resultJson !== 'string') {
    throw new Error(`compactFollowupErrorReasonJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== 'string') {
    throw new Error('compactFollowupErrorReasonJson native returned invalid reason');
  }
  return parsed;
}

export function resolveAdapterContextProviderKeyWithNative(adapterContext: unknown): string {
  const capability = 'resolveAdapterContextProviderKeyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveAdapterContextProviderKeyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ adapterContext }));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveAdapterContextProviderKeyJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' ? parsed : '';
}

export function hasStopMessageAutoCliResultInRequestWithNative(input: {
  adapterContext: unknown;
  runtimeMetadata?: unknown;
}): boolean {
  const capability = 'hasStopMessageAutoCliResultInRequestJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('hasStopMessageAutoCliResultInRequestJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`hasStopMessageAutoCliResultInRequestJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`hasStopMessageAutoCliResultInRequestJson native returned invalid bool: ${resultJson}`);
}

export function extractServertoolCliResultRouteHintFromRequestWithNative(input: {
  adapterContext: unknown;
  runtimeMetadata?: unknown;
}): string | undefined {
  const capability = 'extractServertoolCliResultRouteHintFromRequestJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractServertoolCliResultRouteHintFromRequestJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`extractServertoolCliResultRouteHintFromRequestJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}

export function extractStopMessageAutoCliResultSnapshotFromRequestWithNative(input: {
  adapterContext: unknown;
  runtimeMetadata?: unknown;
}): Record<string, unknown> | undefined {
  const capability = 'extractStopMessageAutoCliResultSnapshotFromRequestJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractStopMessageAutoCliResultSnapshotFromRequestJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`extractStopMessageAutoCliResultSnapshotFromRequestJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractStopMessageAutoCliResultSnapshotFromRequestJson native returned invalid snapshot');
  }
  return parsed as Record<string, unknown>;
}

export function extractCurrentAssistantReasoningStopArgumentsWithNative(
  payload: unknown
): string | null {
  const capability = 'extractCurrentAssistantReasoningStopArgumentsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractCurrentAssistantReasoningStopArgumentsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(payload));
  if (typeof resultJson !== 'string') {
    throw new Error(
      `extractCurrentAssistantReasoningStopArgumentsJson native returned non-string: ${typeof resultJson}`
    );
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed == null) {
    return null;
  }
  if (typeof parsed !== 'string') {
    throw new Error(
      `extractCurrentAssistantReasoningStopArgumentsJson native returned invalid payload: ${typeof parsed}`
    );
  }
  return parsed;
}

export function stripStopSchemaControlTextWithNative(text: string): string {
  const capability = 'stripStopSchemaControlTextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('stripStopSchemaControlTextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(text));
  if (typeof resultJson !== 'string') {
    throw new Error(`stripStopSchemaControlTextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'string') {
    throw new Error(`stripStopSchemaControlTextJson native returned invalid payload: ${typeof parsed}`);
  }
  return parsed;
}

export function buildStopMessageTerminalVisiblePayloadWithNative<TPayload extends Record<string, unknown>>(input: {
  payload: TPayload;
  mode: 'strip' | 'prefix' | 'replace';
  prefix?: string | null;
}): TPayload {
  const capability = 'buildStopMessageTerminalVisiblePayloadJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildStopMessageTerminalVisiblePayloadJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    payload: input.payload,
    mode: input.mode,
    prefix: input.prefix ?? null
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`buildStopMessageTerminalVisiblePayloadJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`buildStopMessageTerminalVisiblePayloadJson native returned invalid payload: ${typeof parsed}`);
  }
  const payload = (parsed as Record<string, unknown>).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('buildStopMessageTerminalVisiblePayloadJson native returned invalid terminal payload');
  }
  return payload as TPayload;
}
