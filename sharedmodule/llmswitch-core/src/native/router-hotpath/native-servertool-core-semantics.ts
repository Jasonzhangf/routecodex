// Native bridge for servertool-core functions.
// Provides inspect_stop_gateway_signal, evaluate_loop_guard, calculate_budget.

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
  hasCapturedRequest: boolean;
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

export interface ClientExecCliProjectionInput {
  toolName: string;
  flowId?: string;
  input?: unknown;
  repeatCount?: number;
  maxRepeats?: number;
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

export interface ServertoolBackendRoutePolicyInput {
  toolName: string;
  flowId?: string;
  input?: unknown;
  entryEndpoint?: string;
}

export interface ServertoolBackendRoutePolicyOutput {
  toolName: string;
  flowId: string;
  routeHint: string;
  executionMode: 'reenter';
  eligible: boolean;
  skipReason?: string | null;
  shapeGuard: {
    allowRequiresAction: boolean;
    preserveStreaming: boolean;
    failOnMissingPayload: boolean;
  };
  originDelta: {
    requiresOriginSeed: boolean;
    applyAssistantDelta: boolean;
  };
  finalize: {
    contextDecorationMode?: string;
    shortCircuitRequiresAction: boolean;
  };
  input: unknown;
}

export interface ServertoolBackendRouteFinalizeDecision {
  contextDecorationMode?: string;
  ignoreRequiresActionFollowup?: boolean;
}

export interface ServertoolFollowupExecutionModeDecision {
  outcomeMode?: 'skip' | 'client_inject_only' | 'reenter';
  noFollowup?: boolean;
  clientInjectOnly?: boolean;
}

export interface ServertoolFollowupExecutionModeInput {
  flowId?: string;
  decision?: ServertoolFollowupExecutionModeDecision;
  metadataClientInjectOnly: boolean;
  clientInjectSource?: string;
}

export interface ServertoolFollowupExecutionModePlan {
  flowId?: string;
  executionMode: 'skip' | 'client_inject_only' | 'reenter';
}

export interface ServertoolFollowupRuntimeActionDecision {
  outcomeMode?: 'skip' | 'client_inject_only' | 'reenter';
  noFollowup?: boolean;
  autoLimit?: boolean;
  clientInjectOnly?: boolean;
  seedLoopPayload?: boolean;
  clientInjectSource?: string;
}

export interface ServertoolFollowupRuntimeActionInput {
  flowId?: string;
  decision?: ServertoolFollowupRuntimeActionDecision;
  metadataClientInjectOnly: boolean;
  hasFollowupPayloadRaw: boolean;
  loopStateRepeatCount?: number;
  clientInjectSource?: string;
}

export interface ServertoolFollowupRuntimeActionPlan {
  flowId?: string;
  loopPayloadSource: 'payload' | 'seed_loop_payload' | 'none';
  autoLimit: {
    exceeded: boolean;
    status?: number;
    code?: 'SERVERTOOL_FOLLOWUP_FAILED';
    category?: 'INTERNAL_ERROR';
    reason?: string;
    repeatCount?: number;
  };
  clientInjectMetadata: {
    force: boolean;
    source?: string;
  };
}

export interface ServertoolFollowupRuntimeMetadataInput {
  metadata: Record<string, unknown>;
  metadataRuntime?: Record<string, unknown> | null;
  adapterContext?: Record<string, unknown> | null;
  adapterRuntime?: Record<string, unknown> | null;
  loopState?: Record<string, unknown> | null;
  originalEntryEndpoint?: string;
  followupEntryEndpoint?: string;
}

export interface ServertoolFollowupRuntimeMetadataPlan {
  rootSet: Record<string, unknown>;
  rootDelete: string[];
  runtimeSet: Record<string, unknown>;
}

export interface ServertoolBackendRouteFinalizeExecution {
  flowId?: string;
  context?: Record<string, unknown>;
}

export type StopMessagePersistedLookupPlanOutput = ReturnType<typeof parseStopMessagePersistedLookupPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

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
  const raw = JSON.parse(resultJson);
  return {
    observed: raw.observed,
    eligible: raw.eligible,
    source: raw.source,
    reason: raw.reason,
    ...(raw.choice_index !== undefined && raw.choice_index !== null ? { choiceIndex: raw.choice_index } : {}),
    ...(raw.has_tool_calls !== undefined && raw.has_tool_calls !== null ? { hasToolCalls: raw.has_tool_calls } : {}),
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
  if (typeof resultJson !== 'string') {
    throw new Error(`buildClientExecCliProjectionOutputJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
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
  if (typeof resultJson !== 'string') {
    throw new Error(`buildClientVisibleProjectionShellJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as Record<string, unknown>;
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

export function planServertoolBackendRoutePolicyWithNative(
  input: ServertoolBackendRoutePolicyInput,
): ServertoolBackendRoutePolicyOutput {
  const capability = 'planServertoolBackendRoutePolicyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolBackendRoutePolicyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolBackendRoutePolicyJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as ServertoolBackendRoutePolicyOutput;
}

export function decorateServertoolFinalChatWithNative(input: {
  chat: Record<string, unknown>;
  execution?: ServertoolBackendRouteFinalizeExecution;
  decision?: ServertoolBackendRouteFinalizeDecision;
}): Record<string, unknown> {
  const capability = 'decorateServertoolFinalChatJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('decorateServertoolFinalChatJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`decorateServertoolFinalChatJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as Record<string, unknown>;
}

export function shouldShortCircuitRequiresActionFollowupWithNative(input: {
  flowId?: string;
  decision?: ServertoolBackendRouteFinalizeDecision;
  hasRequiresActionShape: boolean;
}): boolean {
  const capability = 'shouldShortCircuitRequiresActionFollowupJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('shouldShortCircuitRequiresActionFollowupJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`shouldShortCircuitRequiresActionFollowupJson native returned non-string: ${typeof resultJson}`);
  }
  if (resultJson === 'true') {
    return true;
  }
  if (resultJson === 'false') {
    return false;
  }
  throw new Error(`shouldShortCircuitRequiresActionFollowupJson native returned invalid bool: ${resultJson}`);
}

export function planFollowupExecutionModeWithNative(
  input: ServertoolFollowupExecutionModeInput,
): ServertoolFollowupExecutionModePlan {
  const capability = 'planFollowupExecutionModeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planFollowupExecutionModeJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planFollowupExecutionModeJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planFollowupExecutionModeJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.executionMode !== 'skip' &&
    record.executionMode !== 'client_inject_only' &&
    record.executionMode !== 'reenter'
  ) {
    throw new Error('planFollowupExecutionModeJson native returned invalid executionMode');
  }
  return {
    ...(typeof record.flowId === 'string' && record.flowId.trim() ? { flowId: record.flowId.trim() } : {}),
    executionMode: record.executionMode
  };
}

export function planFollowupRuntimeActionWithNative(
  input: ServertoolFollowupRuntimeActionInput,
): ServertoolFollowupRuntimeActionPlan {
  const capability = 'planFollowupRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planFollowupRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planFollowupRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planFollowupRuntimeActionJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.loopPayloadSource !== 'payload' &&
    record.loopPayloadSource !== 'seed_loop_payload' &&
    record.loopPayloadSource !== 'none'
  ) {
    throw new Error('planFollowupRuntimeActionJson native returned invalid loopPayloadSource');
  }
  const autoLimit = record.autoLimit;
  if (!autoLimit || typeof autoLimit !== 'object' || Array.isArray(autoLimit)) {
    throw new Error('planFollowupRuntimeActionJson native returned invalid autoLimit');
  }
  const autoLimitRecord = autoLimit as Record<string, unknown>;
  if (typeof autoLimitRecord.exceeded !== 'boolean') {
    throw new Error('planFollowupRuntimeActionJson native returned invalid autoLimit.exceeded');
  }
  const clientInjectMetadata = record.clientInjectMetadata;
  if (!clientInjectMetadata || typeof clientInjectMetadata !== 'object' || Array.isArray(clientInjectMetadata)) {
    throw new Error('planFollowupRuntimeActionJson native returned invalid clientInjectMetadata');
  }
  const clientInjectRecord = clientInjectMetadata as Record<string, unknown>;
  if (typeof clientInjectRecord.force !== 'boolean') {
    throw new Error('planFollowupRuntimeActionJson native returned invalid clientInjectMetadata.force');
  }
  const rawAutoLimitCode =
    typeof autoLimitRecord.code === 'string'
      ? autoLimitRecord.code.trim()
      : '';
  if (rawAutoLimitCode && rawAutoLimitCode !== 'SERVERTOOL_FOLLOWUP_FAILED') {
    throw new Error('planFollowupRuntimeActionJson native returned invalid autoLimit.code');
  }
  const autoLimitCode: 'SERVERTOOL_FOLLOWUP_FAILED' | undefined =
    rawAutoLimitCode ? 'SERVERTOOL_FOLLOWUP_FAILED' : undefined;
  const rawAutoLimitCategory =
    typeof autoLimitRecord.category === 'string'
      ? autoLimitRecord.category.trim()
      : '';
  if (rawAutoLimitCategory && rawAutoLimitCategory !== 'INTERNAL_ERROR') {
    throw new Error('planFollowupRuntimeActionJson native returned invalid autoLimit.category');
  }
  const autoLimitCategory: 'INTERNAL_ERROR' | undefined =
    rawAutoLimitCategory ? 'INTERNAL_ERROR' : undefined;
  return {
    ...(typeof record.flowId === 'string' && record.flowId.trim() ? { flowId: record.flowId.trim() } : {}),
    loopPayloadSource: record.loopPayloadSource,
    autoLimit: {
      exceeded: autoLimitRecord.exceeded,
      ...(Number.isInteger(autoLimitRecord.status) ? { status: autoLimitRecord.status as number } : {}),
      ...(autoLimitCode
        ? { code: autoLimitCode }
        : {}),
      ...(autoLimitCategory
        ? { category: autoLimitCategory }
        : {}),
      ...(typeof autoLimitRecord.reason === 'string' && autoLimitRecord.reason.trim()
        ? { reason: autoLimitRecord.reason.trim() }
        : {}),
      ...(Number.isInteger(autoLimitRecord.repeatCount) ? { repeatCount: autoLimitRecord.repeatCount as number } : {})
    },
    clientInjectMetadata: {
      force: clientInjectRecord.force,
      ...(typeof clientInjectRecord.source === 'string' && clientInjectRecord.source.trim()
        ? { source: clientInjectRecord.source.trim() }
        : {})
    }
  };
}

export function planFollowupRuntimeMetadataWithNative(
  input: ServertoolFollowupRuntimeMetadataInput,
): ServertoolFollowupRuntimeMetadataPlan {
  const capability = 'planFollowupRuntimeMetadataJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planFollowupRuntimeMetadataJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planFollowupRuntimeMetadataJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planFollowupRuntimeMetadataJson native returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  const rootSet = record.rootSet;
  const rootDelete = record.rootDelete;
  const runtimeSet = record.runtimeSet;
  if (!rootSet || typeof rootSet !== 'object' || Array.isArray(rootSet)) {
    throw new Error('planFollowupRuntimeMetadataJson native returned invalid rootSet');
  }
  if (!Array.isArray(rootDelete) || rootDelete.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('planFollowupRuntimeMetadataJson native returned invalid rootDelete');
  }
  if (!runtimeSet || typeof runtimeSet !== 'object' || Array.isArray(runtimeSet)) {
    throw new Error('planFollowupRuntimeMetadataJson native returned invalid runtimeSet');
  }
  return {
    rootSet: rootSet as Record<string, unknown>,
    rootDelete: rootDelete.map((item) => item.trim()),
    runtimeSet: runtimeSet as Record<string, unknown>
  };
}

export function extractTextFromChatLikeWithNative(payload: unknown): string {
  const capability = 'extractServertoolTextFromChatLikeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('extractServertoolTextFromChatLikeJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(payload));
  if (typeof resultJson !== 'string') {
    throw new Error(`extractServertoolTextFromChatLikeJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'string') {
    throw new Error(`extractServertoolTextFromChatLikeJson native returned invalid payload: ${typeof parsed}`);
  }
  return parsed;
}
