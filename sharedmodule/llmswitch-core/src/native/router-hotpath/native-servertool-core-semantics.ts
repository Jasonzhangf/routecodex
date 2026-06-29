// Native bridge for servertool-core functions.
// Provides inspect_stop_gateway_signal, evaluate_loop_guard, calculate_budget.

import type { JsonObject } from '../../conversion/hub/types/json.js';
import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import { parseStopMessagePersistedLookupPlanPayload } from './native-router-hotpath-analysis.js';

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

export interface PendingSessionSavePlan {
  fileName: string;
  payload: PendingServerToolInjectionPlan;
}

export type PendingSessionLoadPlan =
  | {
      action: 'use';
      pending: PendingServerToolInjectionPlan;
    }
  | {
      action: 'drop';
      reason: string;
      message: string;
    };

export interface PendingInjectionPersistInput {
  pendingInjection: unknown;
  requestId: string;
  flowId: string;
  createdAtMs: number;
}

export type PendingInjectionPersistPlan =
  | { action: 'skip' }
  | {
      action: 'persist';
      sessionIds: string[];
      records: Array<{
        sessionId: string;
        pending: Omit<PendingServerToolInjectionPlan, 'version' | 'sessionId'>;
      }>;
    };

export interface PendingInjectionPersistErrorPlan {
  message: string;
  code: string;
  category: string;
  status: number;
  details: Record<string, unknown>;
}

export interface PreCommandRegexPlan {
  source: string;
  flags: string;
}

export interface PreCommandHookRulePlan {
  id: string;
  toolNames: string[];
  cmdRegex?: PreCommandRegexPlan;
  jqExpression?: string;
  shellCommand?: string;
  runtimeScriptPath?: string;
  timeoutMs: number;
  priority: number;
  order: number;
}

export interface PreCommandHooksConfigPlan {
  enabled: boolean;
  hooks: PreCommandHookRulePlan[];
}

export interface RuntimePreCommandStateSelectionPlan {
  action: 'use_selected';
  source: 'runtime_control' | 'none';
  state?: Record<string, unknown>;
}

export interface RuntimePreCommandStateRuntimeActionPlan {
  action: 'use_selected';
  source: 'runtime_control' | 'none';
  state?: Record<string, unknown>;
}

export interface AutoHookTraceEventPlan {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  result: 'miss' | 'match' | 'error';
  reason: string;
  flowId?: string;
}

export interface AutoHookRuntimeAttemptPlan {
  traceEvent: AutoHookTraceEventPlan;
  returnResult: boolean;
  continueQueue: boolean;
  rethrowError: boolean;
  errorMessage?: string;
}

export interface AutoHookCallerFinalizationPlan {
  returnResult: boolean;
  continueNextQueue: boolean;
  returnNull: boolean;
}

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

export interface EngineSelectionAfterRunPlan {
  action: 'rerun_excluding_primary_hooks' | 'return_current';
  overrides?: EngineSelectionOverridesPlan;
}

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

export interface NativeServertoolExecutionSummary {
  flowId: string;
  followup?: unknown;
  context?: unknown;
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

export interface ServertoolExecutionBranchPlan {
  action: 'client_exec_cli_projection' | 'resolve_execution_outcome' | 'continue_response_stage';
  projectedToolCallId?: string;
  projectedToolCallIndex?: number;
}

export interface ServertoolEnginePreflightPlan {
  action:
    | 'return_original_chat'
    | 'return_original_chat_direct_passthrough'
    | 'continue_to_engine';
}

export interface ServertoolEngineRuntimeActionPlan {
  action:
    | 'persist_pending_injection_and_return'
    | 'return_servertool_cli_projection_final'
    | 'return_stop_message_terminal_final'
    | 'build_stop_message_cli_projection';
}

export interface ServertoolEngineSkipPlan {
  action:
    | 'return_skipped_passthrough'
    | 'return_skipped_no_execution'
    | 'continue_matched_flow';
  skipReason?: string;
}

export interface ServertoolExecutionOutcomeRuntimeActionPlan {
  action:
    | 'return_mixed_client_tools_pending_injection'
    | 'invalid_mixed_client_tools_outcome'
    | 'reuse_last_execution_followup'
    | 'use_resolved_followup'
    | 'missing_followup_contract';
  reuseLastExecutionEnvelope?: boolean;
  selectedFollowup?: unknown;
  selectedExecutionEnvelope?: unknown;
  pendingInjection?: unknown;
  executionFlowId: string;
}

export interface ServertoolExecutionLoopRuntimeActionPlan {
  action:
    | 'skip_non_tool_call_handler'
    | 'throw_dispatch_spec_mismatch'
    | 'apply_materialized_result'
    | 'apply_handler_error_tool_output'
    | 'continue_without_effect';
}

export interface ServertoolExecutionLoopEffectPlan {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  execution: {
    flowId: string;
    followup?: unknown;
  };
}

export interface ServertoolResponseStageRuntimeActionPlan {
  action:
    | 'return_passthrough_bypass'
    | 'run_auto_hooks'
    | 'return_auto_hook_result'
    | 'return_required_response_hook_empty'
    | 'return_passthrough_no_auto_hook_result';
}

export interface ServertoolEntryPreflightPlan {
  action:
  | 'return_passthrough_non_object_chat'
  | 'throw_client_disconnected'
  | 'continue_to_tool_flow';
}

export interface ServertoolHandlerRuntimeActionPlan {
  action:
    | 'finalize_without_backend'
    | 'return_handler_result'
    | 'invalid_plan_missing_finalize'
    | 'invalid_plan_result'
    | 'unsupported_backend_plan_kind';
  backendKind?: string;
}

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

export interface ServertoolMaterializationProgressPlan {
  action:
    | 'finalize_without_backend'
    | 'return_handler_result'
    | 'invalid_plan_missing_finalize'
    | 'invalid_plan_result'
    | 'unsupported_backend_plan_kind';
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
  const resultJson = fn(JSON.stringify(input));
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

export function resolvePendingSessionFileNameWithNative(sessionId: string): string | undefined {
  const capability = 'resolvePendingSessionFileNameJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolvePendingSessionFileNameJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ sessionId }));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolvePendingSessionFileNameJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}

export function resolvePendingSessionMaxAgeMsWithNative(raw: unknown): number {
  const capability = 'resolvePendingSessionMaxAgeMsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolvePendingSessionMaxAgeMsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ raw }));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolvePendingSessionMaxAgeMsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!Number.isInteger(parsed) || (parsed as number) <= 0) {
    throw new Error('resolvePendingSessionMaxAgeMsJson native returned invalid max age');
  }
  return parsed as number;
}

export function planPendingSessionSaveWithNative(input: {
  sessionId: string;
  pending: Record<string, unknown>;
}): PendingSessionSavePlan | null {
  const capability = 'planPendingSessionSaveJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planPendingSessionSaveJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planPendingSessionSaveJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planPendingSessionSaveJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.fileName !== 'string' || !record.fileName.trim()) {
    throw new Error('planPendingSessionSaveJson native returned invalid fileName');
  }
  return {
    fileName: record.fileName.trim(),
    payload: parsePendingServerToolInjectionPlan(record.payload, capability)
  };
}

export function planPendingSessionLoadWithNative(input: {
  raw: unknown;
  nowMs: number;
  maxAgeMs: number;
}): PendingSessionLoadPlan {
  const capability = 'planPendingSessionLoadJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planPendingSessionLoadJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planPendingSessionLoadJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planPendingSessionLoadJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action === 'use') {
    return {
      action: 'use',
      pending: parsePendingServerToolInjectionPlan(record.pending, capability)
    };
  }
  if (record.action === 'drop') {
    if (
      typeof record.reason !== 'string' ||
      !record.reason.trim() ||
      typeof record.message !== 'string' ||
      !record.message.trim()
    ) {
      throw new Error('planPendingSessionLoadJson native returned invalid drop plan');
    }
    return {
      action: 'drop',
      reason: record.reason.trim(),
      message: record.message.trim()
    };
  }
  throw new Error('planPendingSessionLoadJson native returned invalid action');
}

export function planPendingInjectionPersistWithNative(
  input: PendingInjectionPersistInput,
): PendingInjectionPersistPlan {
  const capability = 'planPendingInjectionPersistJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planPendingInjectionPersistJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planPendingInjectionPersistJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planPendingInjectionPersistJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action === 'skip') {
    return { action: 'skip' };
  }
  if (record.action !== 'persist') {
    throw new Error('planPendingInjectionPersistJson native returned invalid action');
  }
  if (
    !Array.isArray(record.sessionIds) ||
    !record.sessionIds.every((item) => typeof item === 'string' && item.trim()) ||
    !Array.isArray(record.records)
  ) {
    throw new Error('planPendingInjectionPersistJson native returned invalid persist plan');
  }
  return {
    action: 'persist',
    sessionIds: record.sessionIds.map((item) => String(item).trim()),
    records: record.records.map((item) => parsePendingInjectionPersistRecord(item, capability))
  };
}

export function planPendingInjectionPersistErrorWithNative(input: {
  requestId: string;
  flowId: string;
  sessionIds: unknown[];
  reason: string;
}): PendingInjectionPersistErrorPlan {
  const capability = 'planPendingInjectionPersistErrorJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planPendingInjectionPersistErrorJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planPendingInjectionPersistErrorJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planPendingInjectionPersistErrorJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.message !== 'string' ||
    !record.message.trim() ||
    typeof record.code !== 'string' ||
    !record.code.trim() ||
    typeof record.category !== 'string' ||
    !record.category.trim() ||
    !Number.isInteger(record.status) ||
    typeof record.details !== 'object' ||
    record.details === null ||
    Array.isArray(record.details)
  ) {
    throw new Error('planPendingInjectionPersistErrorJson native returned invalid error plan');
  }
  return {
    message: record.message.trim(),
    code: record.code.trim(),
    category: record.category.trim(),
    status: record.status as number,
    details: record.details as Record<string, unknown>
  };
}

export function planPreCommandHooksConfigWithNative(raw: unknown): PreCommandHooksConfigPlan {
  const capability = 'planPreCommandHooksConfigJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planPreCommandHooksConfigJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ raw }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planPreCommandHooksConfigJson native returned non-string: ${typeof resultJson}`);
  }
  return parsePreCommandHooksConfigPlan(JSON.parse(resultJson) as unknown, capability);
}

export function planRuntimePreCommandRuleWithNative(input: {
  rawState: unknown;
  envTimeoutMs?: unknown;
  scriptPathAllowed: boolean;
}): PreCommandHookRulePlan | null {
  const capability = 'planRuntimePreCommandRuleJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planRuntimePreCommandRuleJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planRuntimePreCommandRuleJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  return parsePreCommandHookRulePlan(parsed, capability);
}

export function planRuntimePreCommandStateSelectionWithNative(input: {
  runtimeControlPreCommandState?: unknown;
}): RuntimePreCommandStateSelectionPlan {
  const capability = 'planRuntimePreCommandStateSelectionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planRuntimePreCommandStateSelectionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planRuntimePreCommandStateSelectionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planRuntimePreCommandStateSelectionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'use_selected') {
    throw new Error('planRuntimePreCommandStateSelectionJson native returned invalid action');
  }
  if (record.source !== 'runtime_control' && record.source !== 'none') {
    throw new Error('planRuntimePreCommandStateSelectionJson native returned invalid source');
  }
  const state = record.state;
  if (state !== undefined && (typeof state !== 'object' || state === null || Array.isArray(state))) {
    throw new Error('planRuntimePreCommandStateSelectionJson native returned invalid state');
  }
  return {
    action: record.action,
    source: record.source,
    ...(state ? { state: state as Record<string, unknown> } : {})
  };
}

export function planRuntimePreCommandStateRuntimeActionWithNative(input: {
  runtimeControlPreCommandState?: unknown;
}): RuntimePreCommandStateRuntimeActionPlan {
  const capability = 'planRuntimePreCommandStateRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planRuntimePreCommandStateRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planRuntimePreCommandStateRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planRuntimePreCommandStateRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'use_selected') {
    throw new Error('planRuntimePreCommandStateRuntimeActionJson native returned invalid action');
  }
  if (record.source !== 'runtime_control' && record.source !== 'none') {
    throw new Error('planRuntimePreCommandStateRuntimeActionJson native returned invalid source');
  }
  const state = record.state;
  if (state !== undefined && (typeof state !== 'object' || state === null || Array.isArray(state))) {
    throw new Error('planRuntimePreCommandStateRuntimeActionJson native returned invalid state');
  }
  return {
    action: record.action,
    source: record.source,
    ...(state ? { state: state as Record<string, unknown> } : {})
  };
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
  message?: string;
  materializedFlowId?: string;
}): AutoHookRuntimeAttemptPlan {
  const capability = 'planAutoHookRuntimeAttemptJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookRuntimeAttemptJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
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
  return {
    traceEvent: {
      hookId: traceRecord.hookId,
      phase: traceRecord.phase,
      priority: traceRecord.priority,
      queue: traceRecord.queue,
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

export function planAutoHookCallerFinalizationWithNative(input: {
  resultPresent: boolean;
  finalQueue: boolean;
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
  return {
    returnResult: record.returnResult,
    continueNextQueue: record.continueNextQueue,
    returnNull: record.returnNull
  };
}

export function planServertoolExecutionBranchWithNative(input: {
  executableToolCalls: Array<{
    id: string;
    name: string;
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
  if (
    record.projectedToolCallIndex !== undefined &&
    (!Number.isInteger(record.projectedToolCallIndex) || Number(record.projectedToolCallIndex) < 0)
  ) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCallIndex');
  }
  return {
    action: record.action,
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
  return {
    action: record.action
  };
}

export function planServertoolEngineRuntimeActionWithNative(input: {
  hasPendingInjection: boolean;
  isStopMessageFlow: boolean;
  hasServertoolCliProjectionContext?: boolean;
  stoplessAction: string;
}): ServertoolEngineRuntimeActionPlan {
  const capability = 'planServertoolEngineRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineRuntimeActionJson native unavailable');
  }
  const payload: Record<string, unknown> = {
    hasPendingInjection: input.hasPendingInjection,
    isStopMessageFlow: input.isStopMessageFlow,
    hasServertoolCliProjectionContext: input.hasServertoolCliProjectionContext === true,
    stoplessAction: input.stoplessAction
  };
  const raw = fn(JSON.stringify(payload));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'persist_pending_injection_and_return' &&
    record.action !== 'return_servertool_cli_projection_final' &&
    record.action !== 'return_stop_message_terminal_final' &&
    record.action !== 'build_stop_message_cli_projection'
  ) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid action');
  }
  return {
    action: record.action
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
  return {
    action: record.action,
    ...(typeof record.skipReason === 'string' && record.skipReason.trim()
      ? { skipReason: record.skipReason }
      : {})
  };
}

export function planServertoolExecutionOutcomeRuntimeActionWithNative(input: {
  outcomeMode: string;
  requiresPendingInjection: boolean;
  followupStrategy: string;
  useLastExecutionFollowup: boolean;
  hasLastExecutionFollowup: boolean;
  hasResolvedFollowup: boolean;
  hasLastExecution: boolean;
  executedToolCallsLen: number;
  lastExecution?: unknown;
  resolvedFollowup?: unknown;
  flowId?: string;
  pendingSessionId?: string;
  aliasSessionIds?: string[];
  remainingToolCallIds?: string[];
  pendingInjectionMessagesResolved?: unknown[];
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
    record.action !== 'return_mixed_client_tools_pending_injection' &&
    record.action !== 'invalid_mixed_client_tools_outcome' &&
    record.action !== 'reuse_last_execution_followup' &&
    record.action !== 'use_resolved_followup' &&
    record.action !== 'missing_followup_contract'
  ) {
    throw new Error('planServertoolExecutionOutcomeRuntimeActionJson native returned invalid action');
  }
  return {
    action: record.action,
    reuseLastExecutionEnvelope: record.reuseLastExecutionEnvelope === true,
    ...(record.selectedFollowup !== undefined
      ? { selectedFollowup: record.selectedFollowup }
      : {}),
    ...(record.selectedExecutionEnvelope !== undefined
      ? { selectedExecutionEnvelope: record.selectedExecutionEnvelope }
      : {}),
    ...(record.pendingInjection !== undefined
      ? { pendingInjection: record.pendingInjection }
      : {}),
    executionFlowId:
      typeof record.executionFlowId === 'string' && record.executionFlowId.trim()
        ? record.executionFlowId
        : input.outcomeMode === 'mixed_client_tools'
          ? 'servertool_mixed'
          : 'servertool_multi'
  };
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
  mode: string;
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopFlowId?: string;
  noopFollowup?: unknown;
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
  return {
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      ...(typeof toolCall.executionMode === 'string' ? { executionMode: toolCall.executionMode } : {}),
      ...(typeof toolCall.stripAfterExecute === 'boolean' ? { stripAfterExecute: toolCall.stripAfterExecute } : {})
    },
    execution: {
      flowId: execution.flowId,
      ...(execution.followup !== undefined ? { followup: execution.followup } : {})
    }
  };
}

export function planServertoolResponseStageRuntimeActionWithNative(input: {
  responseStageGatePlan?: unknown;
  responseStageNextAction?: string;
  autoHookEvaluated: boolean;
  hasAutoHookResult: boolean;
  responseHookRequired: boolean;
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
  return {
    action: record.action
  };
}

export function planServertoolEntryPreflightWithNative(input: {
  hasBaseObject: boolean;
  adapterClientDisconnected: boolean;
}): ServertoolEntryPreflightPlan {
  const capability = 'planServertoolEntryPreflightJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryPreflightJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
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
  return {
    action: record.action
  };
}

export type ServertoolRegistryRegistrationActionPlan = {
  action: 'ignore_invalid' | 'ignore_builtin_override' | 'ignore_disabled' | 'register_adhoc';
  canonicalName?: string;
};

export function planServertoolRegistryRegistrationActionWithNative(input: {
  name: string;
  hasHandler: boolean;
  builtinNameMatched: boolean;
  builtinEntryPresent: boolean;
  registrationAllowedByConfig: boolean;
}): ServertoolRegistryRegistrationActionPlan {
  const capability = 'planServertoolRegistryRegistrationActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistryRegistrationActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistryRegistrationActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRegistryRegistrationActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'ignore_invalid' &&
    record.action !== 'ignore_builtin_override' &&
    record.action !== 'ignore_disabled' &&
    record.action !== 'register_adhoc'
  ) {
    throw new Error('planServertoolRegistryRegistrationActionJson native returned invalid action');
  }
  if (record.canonicalName !== undefined && typeof record.canonicalName !== 'string') {
    throw new Error('planServertoolRegistryRegistrationActionJson native returned invalid canonicalName');
  }
  return {
    action: record.action,
    ...(typeof record.canonicalName === 'string' && record.canonicalName.trim()
      ? { canonicalName: record.canonicalName }
      : {})
  };
}

export type ServertoolRegistryLookupActionPlan = {
  action: 'return_builtin' | 'return_adhoc' | 'return_none';
  canonicalName?: string;
};

export function planServertoolRegistryLookupActionWithNative(input: {
  name: string;
  builtinEntryPresent: boolean;
  adHocEntryPresent: boolean;
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
    record.action !== 'return_adhoc' &&
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
    return {
      id: record.id,
      phase: record.phase,
      priority: record.priority,
      order: record.order
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

export type ServertoolRegistrySourceKind = 'builtin' | 'adhoc';

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
  if (value !== 'builtin' && value !== 'adhoc') {
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
  adHocNames: string[];
  builtinAutoHandlerNames: string[];
  adHocAutoHandlerNames: string[];
  builtinRecords: Array<{
    name: string;
    trigger: string;
  }>;
  adHocRecords: Array<{
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

export function planServertoolHandlerRuntimeActionWithNative(input: {
  hasFinalizeFunction: boolean;
  hasChatResponseObject: boolean;
  hasExecutionObject: boolean;
  hasExecutionFlowId: boolean;
  hasPlanMarkers: boolean;
  hasBackendPlan: boolean;
  backendKind?: string;
}): ServertoolHandlerRuntimeActionPlan {
  const capability = 'planServertoolHandlerRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolHandlerRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolHandlerRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolHandlerRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'finalize_without_backend' &&
    record.action !== 'return_handler_result' &&
    record.action !== 'invalid_plan_missing_finalize' &&
    record.action !== 'invalid_plan_result' &&
    record.action !== 'unsupported_backend_plan_kind'
  ) {
    throw new Error('planServertoolHandlerRuntimeActionJson native returned invalid action');
  }
  if (record.backendKind !== undefined && typeof record.backendKind !== 'string') {
    throw new Error('planServertoolHandlerRuntimeActionJson native returned invalid backendKind');
  }
  return {
    action: record.action,
    ...(typeof record.backendKind === 'string' && record.backendKind.trim()
      ? { backendKind: record.backendKind }
      : {})
  };
}

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
  return {
    action: record.action,
    ...(record.overrides === undefined || record.overrides === null
      ? {}
      : { overrides: parseEngineSelectionOverridesPlan(record.overrides, capability) })
  };
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

function parsePreCommandHooksConfigPlan(value: unknown, capability: string): PreCommandHooksConfigPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid config plan`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean' || !Array.isArray(record.hooks)) {
    throw new Error(`${capability} native returned incomplete config plan`);
  }
  return {
    enabled: record.enabled,
    hooks: record.hooks.map((item) => parsePreCommandHookRulePlan(item, capability))
  };
}

function parsePreCommandHookRulePlan(value: unknown, capability: string): PreCommandHookRulePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid hook rule`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id.trim() ||
    !Array.isArray(record.toolNames) ||
    !record.toolNames.every((item) => typeof item === 'string' && item.trim()) ||
    !Number.isInteger(record.timeoutMs) ||
    !Number.isInteger(record.priority) ||
    !Number.isInteger(record.order)
  ) {
    throw new Error(`${capability} native returned incomplete hook rule`);
  }
  const cmdRegex = parsePreCommandRegexPlan(record.cmdRegex, capability);
  const jqExpression = typeof record.jqExpression === 'string' && record.jqExpression.trim()
    ? record.jqExpression.trim()
    : undefined;
  const shellCommand = typeof record.shellCommand === 'string' && record.shellCommand.trim()
    ? record.shellCommand.trim()
    : undefined;
  const runtimeScriptPath = typeof record.runtimeScriptPath === 'string' && record.runtimeScriptPath.trim()
    ? record.runtimeScriptPath.trim()
    : undefined;
  return {
    id: record.id.trim(),
    toolNames: record.toolNames.map((item) => String(item).trim()),
    ...(cmdRegex ? { cmdRegex } : {}),
    ...(jqExpression ? { jqExpression } : {}),
    ...(shellCommand ? { shellCommand } : {}),
    ...(runtimeScriptPath ? { runtimeScriptPath } : {}),
    timeoutMs: record.timeoutMs as number,
    priority: record.priority as number,
    order: record.order as number
  };
}

function parsePreCommandRegexPlan(value: unknown, capability: string): PreCommandRegexPlan | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid regex plan`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.source !== 'string' || typeof record.flags !== 'string') {
    throw new Error(`${capability} native returned incomplete regex plan`);
  }
  return {
    source: record.source,
    flags: record.flags
  };
}

function parsePendingInjectionPersistRecord(value: unknown, capability: string): {
  sessionId: string;
  pending: Omit<PendingServerToolInjectionPlan, 'version' | 'sessionId'>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid persist record`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
    throw new Error(`${capability} native returned invalid persist sessionId`);
  }
  const pending = record.pending;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    throw new Error(`${capability} native returned invalid persist pending payload`);
  }
  const pendingRecord = pending as Record<string, unknown>;
  if (!Number.isInteger(pendingRecord.createdAtMs) || (pendingRecord.createdAtMs as number) <= 0) {
    throw new Error(`${capability} native returned invalid persist createdAtMs`);
  }
  if (
    !Array.isArray(pendingRecord.afterToolCallIds) ||
    !pendingRecord.afterToolCallIds.every((item) => typeof item === 'string' && item.trim()) ||
    !Array.isArray(pendingRecord.messages) ||
    !pendingRecord.messages.every((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  ) {
    throw new Error(`${capability} native returned invalid persist pending data`);
  }
  return {
    sessionId: record.sessionId.trim(),
    pending: {
      createdAtMs: pendingRecord.createdAtMs as number,
      afterToolCallIds: pendingRecord.afterToolCallIds.map((item) => String(item).trim()),
      messages: pendingRecord.messages as Record<string, unknown>[],
      ...(typeof pendingRecord.sourceRequestId === 'string' && pendingRecord.sourceRequestId.trim()
        ? { sourceRequestId: pendingRecord.sourceRequestId.trim() }
        : {})
    }
  };
}

function parsePendingServerToolInjectionPlan(value: unknown, capability: string): PendingServerToolInjectionPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid pending payload`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`${capability} native returned invalid pending version`);
  }
  if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
    throw new Error(`${capability} native returned invalid pending sessionId`);
  }
  if (!Number.isInteger(record.createdAtMs) || (record.createdAtMs as number) <= 0) {
    throw new Error(`${capability} native returned invalid pending createdAtMs`);
  }
  if (
    !Array.isArray(record.afterToolCallIds) ||
    !record.afterToolCallIds.every((item) => typeof item === 'string' && item.trim())
  ) {
    throw new Error(`${capability} native returned invalid pending afterToolCallIds`);
  }
  if (
    !Array.isArray(record.messages) ||
    !record.messages.every((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  ) {
    throw new Error(`${capability} native returned invalid pending messages`);
  }
  const sourceRequestId = record.sourceRequestId;
  return {
    version: 1,
    sessionId: record.sessionId.trim(),
    createdAtMs: record.createdAtMs as number,
    afterToolCallIds: record.afterToolCallIds.map((item) => String(item).trim()),
    messages: record.messages as Record<string, unknown>[],
    ...(typeof sourceRequestId === 'string' && sourceRequestId.trim()
      ? { sourceRequestId: sourceRequestId.trim() }
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

export function planServertoolHandlerContractErrorWithNative(input:
  | {
      kind: 'handler_failed';
      toolName: string;
      requestId: string;
      entryEndpoint: string;
      providerProtocol: string;
      error: string;
    }
  | {
      kind: 'unsupported_backend_plan_kind';
      requestId: string;
      backendKind: string;
    }
  | {
      kind: 'invalid_handler_plan_missing_finalize';
      requestId: string;
    }
  | {
      kind: 'invalid_handler_plan_result';
      requestId: string;
    }
): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolHandlerContractErrorJson', input),
    'planServertoolHandlerContractErrorJson'
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
      followupStrategy: string;
      requiresPendingInjection: boolean;
    }
  | {
      kind: 'missing_followup_contract';
      requestId: string;
      outcomeMode: string;
      followupStrategy: string;
      useLastExecutionFollowup: boolean;
      useGenericFollowup: boolean;
    }
): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolExecutionDispatchErrorJson', input),
    'planServertoolExecutionDispatchErrorJson'
  );
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

export function planServertoolMaterializationProgressWithNative(input: {
  hasFinalizeFunction: boolean;
  hasChatResponseObject: boolean;
  hasExecutionObject: boolean;
  hasExecutionFlowId: boolean;
  hasPlanMarkers: boolean;
  hasBackendPlan: boolean;
}): ServertoolMaterializationProgressPlan {
  const capability = 'planServertoolMaterializationProgressJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolMaterializationProgressJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolMaterializationProgressJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolMaterializationProgressJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'finalize_without_backend' &&
    record.action !== 'return_handler_result' &&
    record.action !== 'invalid_plan_missing_finalize' &&
    record.action !== 'invalid_plan_result' &&
    record.action !== 'unsupported_backend_plan_kind'
  ) {
    throw new Error('planServertoolMaterializationProgressJson native returned invalid action');
  }
  return { action: record.action };
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
