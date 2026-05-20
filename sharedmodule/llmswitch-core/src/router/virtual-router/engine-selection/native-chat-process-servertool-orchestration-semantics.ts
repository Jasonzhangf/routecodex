import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from '../../../shared/common-utils.js';
import {
  parseServertoolDispatchPlanPayload,
  parseServertoolFollowupFlowProfilePayload,
  parseServertoolFollowupRuntimePlanPayload,
  parseServertoolAutoHookQueuesPayload,
  parseServertoolOutcomePlanPayload,
  parseServertoolResponseStagePayload,
  parseStopMessagePersistedLookupPlanPayload
} from './native-router-hotpath-analysis.js';

export type NativeChatWebSearchPlan = {
  shouldInject: boolean;
  selectedEngineIndexes: number[];
};

export type NativeChatClockPlan = {
  shouldInject: boolean;
};

export type NativeContinueExecutionPlan = {
  shouldInject: boolean;
};

export type NativeContinueDirectiveInjection = {
  changed: boolean;
  messages: unknown[];
};

export type NativePayloadContractSignal = {
  reason: string;
  marker: string;
};

export type NativeChatServerToolBundlePlan = {
  webSearch: NativeChatWebSearchPlan;
  clock: NativeChatClockPlan;
  continueExecution: NativeContinueExecutionPlan;
};

export type NativeServertoolResponseStage = ReturnType<typeof parseServertoolResponseStagePayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolDispatchPlan = ReturnType<typeof parseServertoolDispatchPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolOutcomePlan = ReturnType<typeof parseServertoolOutcomePlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolAutoHookQueues = ReturnType<typeof parseServertoolAutoHookQueuesPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolFollowupFlowProfile = ReturnType<typeof parseServertoolFollowupFlowProfilePayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolFollowupRuntimePlan = ReturnType<typeof parseServertoolFollowupRuntimePlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolSkeletonDocument = Record<string, unknown>;

export type NativeStopMessagePersistedLookupPlan = ReturnType<typeof parseStopMessagePersistedLookupPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

const NON_BLOCKING_SERVERTOOL_ORCHESTRATION_LOG_THROTTLE_MS = 60_000;
const nonBlockingServertoolOrchestrationLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-chat-process-servertool-orchestration-semantics.parse-failed');


function logNativeServertoolOrchestrationNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingServertoolOrchestrationLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_SERVERTOOL_ORCHESTRATION_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingServertoolOrchestrationLogState.set(stage, now);
  console.warn(
    `[native-chat-process-servertool-orchestration-semantics] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeServertoolOrchestrationNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logNativeServertoolOrchestrationNonBlocking('safeStringify', error);
    return undefined;
  }
}

function encodeJsonArg(capability: string, value: unknown): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const encoded = safeStringify(value);
  if (!encoded) {
    return fail('json stringify failed');
  }
  return encoded;
}

function invokeNativeStringCapability(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(...args);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
      return fail(String((raw as { message: unknown }).message));
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeNativeStringCapabilityWithJsonArgs(capability: string, args: unknown[]): string {
  return invokeNativeStringCapability(
    capability,
    args.map((arg) => encodeJsonArg(capability, arg))
  );
}

function parseWebSearchPlan(raw: string): NativeChatWebSearchPlan | null {
  const parsed = parseJson('parseWebSearchPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.shouldInject !== 'boolean' || !Array.isArray(row.selectedEngineIndexes)) {
    return null;
  }
  const selectedEngineIndexes = row.selectedEngineIndexes
    .map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? Math.floor(entry) : null))
    .filter((entry): entry is number => entry !== null && entry >= 0);
  return {
    shouldInject: row.shouldInject,
    selectedEngineIndexes
  };
}

function parseClockPlan(raw: string): NativeChatClockPlan | null {
  const parsed = parseJson('parseClockPlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.shouldInject !== 'boolean') {
    return null;
  }
  return { shouldInject: row.shouldInject };
}

function parseContinueExecutionPlan(raw: string): NativeContinueExecutionPlan | null {
  return parseClockPlan(raw);
}

function parseContinueDirectiveInjection(raw: string): NativeContinueDirectiveInjection | null {
  const parsed = parseJson('parseContinueDirectiveInjection', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.changed !== 'boolean' || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    changed: row.changed,
    messages: row.messages
  };
}

function parseServerToolBundlePlan(raw: string): NativeChatServerToolBundlePlan | null {
  const parsed = parseJson('parseServerToolBundlePlan', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const webSearchRaw = typeof row.webSearch === 'object' ? JSON.stringify(row.webSearch) : '';
  const clockRaw = typeof row.clock === 'object' ? JSON.stringify(row.clock) : '';
  const continueRaw =
    typeof row.continueExecution === 'object' ? JSON.stringify(row.continueExecution) : '';
  const webSearch = webSearchRaw ? parseWebSearchPlan(webSearchRaw) : null;
  const clock = clockRaw ? parseClockPlan(clockRaw) : null;
  const continueExecution = continueRaw ? parseContinueExecutionPlan(continueRaw) : null;
  if (!webSearch || !clock || !continueExecution) {
    return null;
  }
  return { webSearch, clock, continueExecution };
}

function parsePayloadContractSignal(raw: string): NativePayloadContractSignal | null {
  const parsed = parseJson('parsePayloadContractSignal', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.reason !== 'string' || typeof row.marker !== 'string') {
    return null;
  }
  return { reason: row.reason, marker: row.marker };
}

function parseServertoolSkeletonDocument(raw: string): NativeServertoolSkeletonDocument | null {
  const parsed = parseJson('parseServertoolSkeletonDocument', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as NativeServertoolSkeletonDocument;
}

function parseProviderResponseShape(raw: string):
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-chat'
  | 'unknown'
  | null {
  const parsed = parseJson('parseProviderResponseShape', raw);
  if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string') {
    return null;
  }
  if (
    parsed === 'openai-chat' ||
    parsed === 'openai-responses' ||
    parsed === 'anthropic-messages' ||
    parsed === 'gemini-chat' ||
    parsed === 'unknown'
  ) {
    return parsed;
  }
  return null;
}

function parseReviewOperations(raw: string): Record<string, unknown>[] | null {
  const parsed = parseJson('parseReviewOperations', raw);
  if (parsed === JSON_PARSE_FAILED || !Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
  );
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

function parseStringOrUndefined(raw: string): string | undefined | null {
  const parsed = parseJson('parseStringOrUndefined', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

export function detectEmptyAssistantPayloadContractSignalWithNative(
  payload: unknown
): NativePayloadContractSignal | null {
  const capability = 'detectEmptyAssistantPayloadContractSignalJson';
  if (isNativeDisabledByEnv()) {
    return null;
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return null;
  }
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload ?? null]);
    return parsePayloadContractSignal(raw);
  } catch (error) {
    logNativeServertoolOrchestrationNonBlocking(capability, error);
    return null;
  }
}

export function detectProviderResponseShapeWithNative(
  payload: unknown
): 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | 'unknown' {
  const capability = 'detectProviderResponseShapeJson';
  const fail = (reason?: string) =>
    failNativeRequired<'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | 'unknown'>(
      capability,
      reason
    );
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload ?? null]);
    const parsed = parseProviderResponseShape(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isCanonicalChatCompletionPayloadWithNative(payload: unknown): boolean {
  const capability = 'isCanonicalChatCompletionPayloadJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload ?? null]);
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isStopMessageStateActiveWithNative(raw: unknown): boolean {
  const capability = 'isStopMessageStateActiveJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    const response = invokeNativeStringCapabilityWithJsonArgs(capability, [raw ?? null]);
    const parsed = parseBoolean(response);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveStopMessageSessionScopeWithNative(
  metadata: Record<string, unknown>
): string | undefined {
  const capability = 'resolveStopMessageSessionScopeJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  try {
    const response = invokeNativeStringCapabilityWithJsonArgs(capability, [metadata]);
    const parsed = parseStringOrUndefined(response);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolStickyKeyWithNative(
  metadata: Record<string, unknown>
): string | undefined {
  const capability = 'resolveServertoolStickyKeyJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  try {
    const response = invokeNativeStringCapabilityWithJsonArgs(capability, [metadata]);
    const parsed = parseStringOrUndefined(response);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planStopMessagePersistedLookupWithNative(input: {
  record: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
  options?: {
    includeSnapshotLookup?: boolean;
    includeTombstoneLookup?: boolean;
  };
}): NativeStopMessagePersistedLookupPlan {
  const capability = 'planStopMessagePersistedLookupJson';
  const fail = (reason?: string) => failNativeRequired<NativeStopMessagePersistedLookupPlan>(capability, reason);
  try {
    const response = invokeNativeStringCapabilityWithJsonArgs(capability, [input]);
    const parsed = parseStopMessagePersistedLookupPlanPayload(response);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveHasActiveStopMessageForContinueExecutionWithNative(
  runtimeState: unknown,
  persistedState: unknown
): boolean {
  const capability = 'resolveHasActiveStopMessageForContinueExecutionJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    const response = invokeNativeStringCapabilityWithJsonArgs(capability, [
      runtimeState ?? null,
      persistedState ?? null
    ]);
    const parsed = parseBoolean(response);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildReviewOperationsWithNative(
  metadata: Record<string, unknown>
): Record<string, unknown>[] {
  const capability = 'buildReviewOperationsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>[]>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [metadata]);
    const parsed = parseReviewOperations(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildContinueExecutionOperationsWithNative(
  shouldInject: boolean
): Record<string, unknown>[] {
  const capability = 'buildContinueExecutionOperationsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>[]>(capability, reason);
  try {
    const raw = invokeNativeStringCapability(capability, [shouldInject === true]);
    const parsed = parseReviewOperations(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planChatWebSearchOperationsWithNative(
  request: unknown,
  runtimeMetadata: Record<string, unknown>
): NativeChatWebSearchPlan {
  const capability = 'planChatWebSearchOperationsJson';
  const fail = (reason?: string) => failNativeRequired<NativeChatWebSearchPlan>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [request ?? null, runtimeMetadata]);
    const parsed = parseWebSearchPlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planChatClockOperationsWithNative(
  runtimeMetadata: Record<string, unknown>
): NativeChatClockPlan {
  const capability = 'planChatClockOperationsJson';
  const fail = (reason?: string) => failNativeRequired<NativeChatClockPlan>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [runtimeMetadata]);
    const parsed = parseClockPlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planContinueExecutionOperationsWithNative(
  runtimeMetadata: Record<string, unknown>,
  hasActiveStopMessage: boolean
): NativeContinueExecutionPlan {
  const capability = 'planContinueExecutionOperationsJson';
  const fail = (reason?: string) => failNativeRequired<NativeContinueExecutionPlan>(capability, reason);
  try {
    const runtimeMetadataJson = encodeJsonArg(capability, runtimeMetadata);
    const raw = invokeNativeStringCapability(capability, [runtimeMetadataJson, hasActiveStopMessage === true]);
    const parsed = parseContinueExecutionPlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function tryPlanChatServerToolBundleWithNative(
  request: unknown,
  runtimeMetadata: Record<string, unknown>,
  hasActiveStopMessage: boolean
): NativeChatServerToolBundlePlan | null {
  const capability = 'planChatServertoolOrchestrationBundleJson';
  const fail = (reason?: string) => failNativeRequired<NativeChatServerToolBundlePlan | null>(capability, reason);
  try {
    const requestJson = encodeJsonArg(capability, request ?? null);
    const runtimeMetadataJson = encodeJsonArg(capability, runtimeMetadata);
    const raw = invokeNativeStringCapability(capability, [
      requestJson,
      runtimeMetadataJson,
      hasActiveStopMessage === true
    ]);
    const parsed = parseServerToolBundlePlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectContinueExecutionDirectiveWithNative(
  messages: unknown[],
  marker: string,
  targetText: string
): NativeContinueDirectiveInjection {
  const capability = 'injectContinueExecutionDirectiveJson';
  const fail = (reason?: string) => failNativeRequired<NativeContinueDirectiveInjection>(capability, reason);
  try {
    const messagesJson = encodeJsonArg(capability, messages);
    const raw = invokeNativeStringCapability(capability, [messagesJson, marker, targetText]);
    const parsed = parseContinueDirectiveInjection(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runServertoolResponseStageWithNative(
  payload: unknown,
  requestId: string
): NativeServertoolResponseStage {
  const capability = 'runServertoolResponseStageJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolResponseStage>(capability, reason);
  try {
    const payloadJson = encodeJsonArg(capability, payload ?? null);
    const raw = invokeNativeStringCapability(capability, [payloadJson, String(requestId || '')]);
    const parsed = parseServertoolResponseStagePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function getDefaultServertoolSkeletonDocumentWithNative(): NativeServertoolSkeletonDocument {
  const capability = 'getDefaultServertoolSkeletonDocumentJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolSkeletonDocument>(capability, reason);
  try {
    const raw = invokeNativeStringCapability(capability, []);
    const parsed = parseServertoolSkeletonDocument(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolToolCallDispatchWithNative(input: {
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  disableToolCallHandlers: boolean;
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  registeredToolCallHandlers: Array<{
    name: string;
    trigger: string;
    executionMode: string;
    stripAfterExecute: boolean;
  }>;
}): NativeServertoolDispatchPlan {
  const capability = 'planServertoolToolCallDispatchJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolDispatchPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolDispatchPlanPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolOutcomeWithNative(input: {
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  executedToolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    executionMode: string;
    stripAfterExecute: boolean;
  }>;
  executedFlowIds: string[];
  lastExecutionFlowId?: string;
  hasLastExecutionFollowup: boolean;
  sessionId?: string;
  conversationId?: string;
  toolOutputs?: unknown[];
  pendingInjectionMessageKinds?: string[];
}): NativeServertoolOutcomePlan {
  const capability = 'planServertoolOutcomeJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolOutcomePlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolOutcomePlanPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolAutoHookQueuesWithNative(input: {
  hooks: Array<{ id: string; phase: string; priority: number; order: number }>;
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
  optionalPrimaryHookOrder: string[];
  mandatoryHookOrder: string[];
}): NativeServertoolAutoHookQueues {
  const capability = 'planServertoolAutoHookQueuesJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolAutoHookQueues>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolAutoHookQueuesPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolFollowupFlowProfileWithNative(
  flowId: string
): NativeServertoolFollowupFlowProfile {
  const capability = 'resolveServertoolFollowupFlowProfileJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolFollowupFlowProfile>(capability, reason);
  try {
    const raw = invokeNativeStringCapability(capability, [String(flowId || '')]);
    const parsed = parseServertoolFollowupFlowProfilePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolFollowupRuntimeWithNative(
  flowId: string
): NativeServertoolFollowupRuntimePlan {
  const capability = 'planServertoolFollowupRuntimeJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolFollowupRuntimePlan>(capability, reason);
  try {
    const raw = invokeNativeStringCapability(capability, [String(flowId || '')]);
    const parsed = parseServertoolFollowupRuntimePlanPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function readFollowupClientInjectSourceWithNative(
  adapterContext: Record<string, unknown>
): string {
  const capability = 'readFollowupClientInjectSourceJson';
  if (isNativeDisabledByEnv()) {
    return '';
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return '';
  }
  const ctxJson = safeStringify(adapterContext);
  if (!ctxJson) {
    return '';
  }
  try {
    const raw = fn(ctxJson);
    if (typeof raw === 'string') {
      return raw;
    }
    return '';
  } catch {
    return '';
  }
}
