import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from '../../shared/common-utils.js';
import {
  parseServertoolDispatchPlanPayload,
  parseServertoolDispatchPlanInputPayload,
  parseServertoolFollowupRuntimePlanPayload,
  parseServertoolHandlerContractPlanPayload,
  parseServertoolAutoHookQueuesPayload,
  parseServertoolOutcomePlanPayload,
  parseServertoolOutcomePlanInputPayload,
  parseServertoolResponseStagePayload,
  parseServertoolResponseStageGatePayload
} from './native-router-hotpath-analysis.js';

export type NativeChatWebSearchPlan = {
  shouldInject: boolean;
  selectedEngineIndexes: number[];
};

export type NativePayloadContractSignal = {
  reason: string;
  marker: string;
};

export type NativeServertoolResponseStage = ReturnType<typeof parseServertoolResponseStagePayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolResponseStageGate = Exclude<
  ReturnType<typeof parseServertoolResponseStageGatePayload>,
  null
>;

export type NativeServertoolDispatchPlan = ReturnType<typeof parseServertoolDispatchPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolDispatchPlanInput = ReturnType<typeof parseServertoolDispatchPlanInputPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolOutcomePlan = ReturnType<typeof parseServertoolOutcomePlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolOutcomePlanInput = ReturnType<typeof parseServertoolOutcomePlanInputPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolHandlerContractPlan = ReturnType<typeof parseServertoolHandlerContractPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolAutoHookQueues = ReturnType<typeof parseServertoolAutoHookQueuesPayload> extends infer T
  ? Exclude<T, null>
  : never;
export type NativeServertoolAutoHookQueueItems<T> = {
  queueOrder: Array<{
    queue: 'A_optional' | 'B_mandatory';
    entries: T[];
  }>;
};

export type NativeServertoolFollowupRuntimePlan = ReturnType<typeof parseServertoolFollowupRuntimePlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export type NativeServertoolSkeletonDocument = Record<string, unknown>;
export type NativeServertoolSkeletonDerivedConfig = Record<string, unknown>;
export type NativeServertoolRegistrationSpec = Record<string, unknown>;
export type NativeServertoolToolSpec = Record<string, unknown>;
export type NativeServertoolBuiltinHandlerEntryPlan =
  | { action: 'return_none' }
  | { action: 'return_entry'; entry: Record<string, unknown> };
export type NativeServertoolBuiltinHandlerNamesPlan = {
  names: string[];
};
export type NativeServertoolBuiltinHandlerEntriesPlan = {
  entries: Record<string, unknown>[];
};
export type NativeServertoolRegistryLookupActionPlan = {
  action: 'return_builtin' | 'return_none';
  canonicalName?: string;
};

export type NativeServertoolNoopOutcome = {
  chatResponse: Record<string, unknown>;
  flowId: string;
  toolContent: Record<string, unknown>;
};

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

function parseServertoolSkeletonDerivedConfig(raw: string): NativeServertoolSkeletonDerivedConfig | null {
  const parsed = parseJson('parseServertoolSkeletonDerivedConfig', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as NativeServertoolSkeletonDerivedConfig;
}

function parseServertoolRegistrationSpec(raw: string): NativeServertoolRegistrationSpec | null {
  const parsed = parseJson('parseServertoolRegistrationSpec', raw);
  if (parsed === JSON_PARSE_FAILED || parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as NativeServertoolRegistrationSpec;
}

function parseServertoolToolSpec(raw: string): NativeServertoolToolSpec | null {
  const parsed = parseJson('parseServertoolToolSpec', raw);
  if (parsed === JSON_PARSE_FAILED || parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as NativeServertoolToolSpec;
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

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
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

export function containsSyntheticRouteCodexControlTextWithNative(payload: unknown): boolean {
  const capability = 'containsSyntheticRoutecodexControlTextJson';
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

export function planServertoolResponseStageGateWithNative(input: {
  payload: unknown;
  adapterContext?: Record<string, unknown>;
  runtimeControl?: Record<string, unknown>;
  allowFollowup?: boolean;
  hasServertoolSupport?: boolean;
}): NativeServertoolResponseStageGate {
  const capability = 'planServertoolResponseStageGateJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolResponseStageGate>(capability, reason);
  try {
    const payload = {
      payload: input.payload ?? null,
      adapterContext: input.adapterContext ?? null,
      runtimeControl: input.runtimeControl ?? null,
      allowFollowup: input.allowFollowup === true,
      ...(typeof input.hasServertoolSupport === 'boolean'
        ? { hasServertoolSupport: input.hasServertoolSupport }
        : {})
    };
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [payload]);
    const parsed = parseServertoolResponseStageGatePayload(raw);
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

export function planServertoolSkeletonDerivedConfigWithNative(input: {
  document?: unknown;
} = {}): NativeServertoolSkeletonDerivedConfig {
  const capability = 'planServertoolSkeletonDerivedConfigJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolSkeletonDerivedConfig>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolSkeletonDerivedConfig(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function readServertoolPrimaryAutoHookIdsWithNative(input: {
  document?: unknown;
} = {}): string[] {
  const capability = 'readServertoolPrimaryAutoHookIdsWithNative';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  const derivedConfig = planServertoolSkeletonDerivedConfigWithNative(input);
  const autoHookQueueConfig = derivedConfig.autoHookQueueConfig;
  if (!autoHookQueueConfig || typeof autoHookQueueConfig !== 'object' || Array.isArray(autoHookQueueConfig)) {
    return fail('missing autoHookQueueConfig');
  }
  const optionalPrimaryOrder = (autoHookQueueConfig as { optionalPrimaryOrder?: unknown }).optionalPrimaryOrder;
  if (!Array.isArray(optionalPrimaryOrder)) {
    return fail('missing optionalPrimaryOrder');
  }
  const ids: string[] = [];
  for (const entry of optionalPrimaryOrder) {
    if (typeof entry !== 'string') {
      return fail('invalid optionalPrimaryOrder entry');
    }
    ids.push(entry);
  }
  return ids;
}

export function buildServertoolDispatchPlanInputWithNative(input: {
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  disableToolCallHandlers: boolean;
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  runtimeMetadata?: Record<string, unknown>;
  document?: unknown;
}): NativeServertoolDispatchPlanInput {
  const capability = 'buildServertoolDispatchPlanInputJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolDispatchPlanInput>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolDispatchPlanInputPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildServertoolOutcomePlanInputWithNative(input: {
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  executionState: unknown;
  adapterContext?: unknown;
  baseForExecution?: unknown;
}): NativeServertoolOutcomePlanInput {
  const capability = 'buildServertoolOutcomePlanInputJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolOutcomePlanInput>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolOutcomePlanInputPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolHandlerContractWithNative(input: {
  hasFinalizeFunction: boolean;
  hasChatResponseObject: boolean;
  hasExecutionObject: boolean;
  hasExecutionFlowId: boolean;
  hasPlanMarkers: boolean;
}): NativeServertoolHandlerContractPlan {
  const capability = 'planServertoolHandlerContractJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolHandlerContractPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolHandlerContractPlanPayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeServertoolRegistrationSpecWithNative(input: {
  name: string;
  options?: Record<string, unknown>;
  document?: unknown;
}): NativeServertoolRegistrationSpec | null {
  const capability = 'normalizeServertoolRegistrationSpecJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolRegistrationSpec | null>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseServertoolRegistrationSpec(raw);
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolToolSpecWithNative(input: {
  name: string;
  document?: unknown;
}): NativeServertoolToolSpec | null {
  const capability = 'resolveServertoolToolSpecJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolToolSpec | null>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    return parseServertoolToolSpec(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolBuiltinHandlerEntryWithNative(input: {
  name: string;
  document?: unknown;
}): NativeServertoolBuiltinHandlerEntryPlan {
  const capability = 'planServertoolBuiltinHandlerEntryJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolBuiltinHandlerEntryPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const record = parsed as Record<string, unknown>;
    if (record.action === 'return_none') {
      return { action: 'return_none' };
    }
    if (
      record.action === 'return_entry' &&
      record.entry &&
      typeof record.entry === 'object' &&
      !Array.isArray(record.entry)
    ) {
      return {
        action: 'return_entry',
        entry: record.entry as Record<string, unknown>
      };
    }
    return fail('invalid action');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolBuiltinHandlerEntryWithNative(input: {
  name: string;
  document?: unknown;
}): Record<string, unknown> | null {
  const capability = 'resolveServertoolBuiltinHandlerEntryJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (parsed === null) {
      return null;
    }
    if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolBuiltinHandlerNamesWithNative(input: {
  document?: unknown;
} = {}): NativeServertoolBuiltinHandlerNamesPlan {
  const capability = 'planServertoolBuiltinHandlerNamesJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolBuiltinHandlerNamesPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const names = (parsed as Record<string, unknown>).names;
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
      return fail('invalid names');
    }
    return {
      names: names.map((name) => name.trim().toLowerCase()).sort()
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseBuiltinHandlerEntriesPlan(
  capability: string,
  raw: string,
  fail: (reason?: string) => NativeServertoolBuiltinHandlerEntriesPlan
): NativeServertoolBuiltinHandlerEntriesPlan {
  const parsed = parseJson(capability, raw);
  if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('invalid payload');
  }
  const entries = (parsed as Record<string, unknown>).entries;
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    return fail('invalid entries');
  }
  return {
    entries: entries as Record<string, unknown>[]
  };
}

export function planServertoolBuiltinAutoHandlerEntriesWithNative(input: {
  document?: unknown;
} = {}): NativeServertoolBuiltinHandlerEntriesPlan {
  const capability = 'planServertoolBuiltinAutoHandlerEntriesJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolBuiltinHandlerEntriesPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    return parseBuiltinHandlerEntriesPlan(capability, raw, fail);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolBuiltinHandlerRecordEntriesWithNative(input: {
  document?: unknown;
} = {}): NativeServertoolBuiltinHandlerEntriesPlan {
  const capability = 'planServertoolBuiltinHandlerRecordEntriesJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolBuiltinHandlerEntriesPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    return parseBuiltinHandlerEntriesPlan(capability, raw, fail);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolRegistryLookupFromSkeletonWithNative(input: {
  name: string;
  document?: unknown;
}): NativeServertoolRegistryLookupActionPlan {
  const capability = 'planServertoolRegistryLookupFromSkeletonJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolRegistryLookupActionPlan>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.action !== 'return_builtin' &&
      record.action !== 'return_none'
    ) {
      return fail('invalid action');
    }
    const canonicalName =
      typeof record.canonicalName === 'string' && record.canonicalName.trim()
        ? record.canonicalName.trim()
        : undefined;
    if (record.action === 'return_builtin' && !canonicalName) {
      return fail('missing canonicalName');
    }
    return {
      action: record.action,
      ...(canonicalName ? { canonicalName } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolRegisteredNameWithNative(input: {
  name: string;
  document?: unknown;
}): boolean {
  const capability = 'resolveServertoolRegisteredNameJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (!parsed || parsed === JSON_PARSE_FAILED || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const registered = (parsed as Record<string, unknown>).registered;
    if (typeof registered !== 'boolean') {
      return fail('invalid registered flag');
    }
    return registered;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolProgressToolNameWithNative(input: {
  flowId: unknown;
  document?: unknown;
}): string {
  const capability = 'resolveServertoolProgressToolNameJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson('resolveServertoolProgressToolName', raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string' || !parsed.trim()) {
      return fail('invalid payload');
    }
    return parsed.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function shouldUseServertoolGoldProgressHighlightWithNative(input: {
  flowId: unknown;
  document?: unknown;
}): boolean {
  const capability = 'shouldUseServertoolGoldProgressHighlightJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveServertoolProgressStageWithNative(input: {
  step: unknown;
  message: unknown;
}): string {
  const capability = 'resolveServertoolProgressStageJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string' || !parsed.trim()) {
      return fail('invalid payload');
    }
    return parsed.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeServertoolProgressResultWithNative(input: {
  message: unknown;
}): string {
  const capability = 'normalizeServertoolProgressResultJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string' || !parsed.trim()) {
      return fail('invalid payload');
    }
    return parsed.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeServertoolProgressTokenWithNative(input: {
  value: unknown;
}): string {
  const capability = 'normalizeServertoolProgressTokenJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string' || !parsed.trim()) {
      return fail('invalid payload');
    }
    return parsed.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeServertoolProgressFlowIdWithNative(input: {
  value: unknown;
}): string {
  const capability = 'normalizeServertoolProgressFlowIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson(capability, raw);
    if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string' || !parsed.trim()) {
      return fail('invalid payload');
    }
    return parsed.trim();
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
  runtimeMetadata?: Record<string, unknown>;
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

export function planServertoolNoopOutcomeWithNative(input: {
  toolCallId: string;
  toolName: string;
  toolArguments?: string;
  base: Record<string, unknown>;
}): NativeServertoolNoopOutcome {
  const capability = 'planServertoolNoopOutcomeJson';
  const fail = (reason?: string) => failNativeRequired<NativeServertoolNoopOutcome>(capability, reason);
  try {
    const inputJson = encodeJsonArg(capability, input);
    const raw = invokeNativeStringCapability(capability, [inputJson]);
    const parsed = parseJson('parseServertoolNoopOutcome', raw);
    if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    if (
      !row.chatResponse || typeof row.chatResponse !== 'object' ||
      typeof row.flowId !== 'string' ||
      !row.toolContent || typeof row.toolContent !== 'object'
    ) {
      return fail('invalid shape');
    }
    return {
      chatResponse: row.chatResponse as Record<string, unknown>,
      flowId: row.flowId,
      toolContent: row.toolContent as Record<string, unknown>
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planServertoolAutoHookQueuesWithNative(input: {
  hooks: Array<{ id: string; phase: string; priority: number; order: number; sourceIndex: number }>;
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

export function planServertoolAutoHookQueueItemsWithNative<T extends {
  id: string;
  phase: string;
  priority: number;
  order: number;
}>(input: {
  hooks: T[];
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
  optionalPrimaryHookOrder: string[];
  mandatoryHookOrder: string[];
}): NativeServertoolAutoHookQueueItems<T> {
  const nativePlan = planServertoolAutoHookQueuesWithNative({
    hooks: input.hooks.map((hook, sourceIndex) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
      sourceIndex
    })),
    ...(input.includeAutoHookIds ? { includeAutoHookIds: input.includeAutoHookIds } : {}),
    ...(input.excludeAutoHookIds ? { excludeAutoHookIds: input.excludeAutoHookIds } : {}),
    optionalPrimaryHookOrder: input.optionalPrimaryHookOrder,
    mandatoryHookOrder: input.mandatoryHookOrder
  });
  return {
    queueOrder: nativePlan.queueOrder.map((queue) => ({
      queue: queue.queue,
      entries: queue.entries.map((entry) => {
        const hook = input.hooks[entry.sourceIndex];
        if (!hook) {
          return failNativeRequired<T>(
            'planServertoolAutoHookQueuesJson',
            `native auto-hook queue returned invalid sourceIndex: ${entry.sourceIndex}`
          );
        }
        return hook;
      })
    }))
  };
}

export function runServertoolOrchestrationMutationWithNative(input: Record<string, unknown>): unknown {
  const capability = 'runServertoolOrchestrationMutationJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [input]);
    const parsed = parseJson('runServertoolOrchestrationMutation', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    return parsed;
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

export function extractCapturedChatSeedWithNative(captured: unknown): Record<string, unknown> | null {
  const capability = 'extractCapturedChatSeedJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [captured ?? null]);
    const parsed = parseJson('extractCapturedChatSeed', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildServertoolReq04FollowupPayloadWithNative(adapterContext: unknown): Record<string, unknown> | null {
  const capability = 'buildServertoolReq04FollowupPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [adapterContext ?? null]);
    const parsed = parseJson('buildServertoolReq04FollowupPayload', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveFollowupModelWithNative(seedModel: unknown, adapterContext: unknown): string {
  const capability = 'resolveFollowupModelJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [seedModel ?? null, adapterContext ?? null]);
    const parsed = parseJson('resolveFollowupModel', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (typeof parsed !== 'string') return fail('invalid payload');
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeFollowupParametersWithNative(parameters: unknown): Record<string, unknown> | undefined {
  const capability = 'normalizeFollowupParametersJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [parameters ?? null]);
    const parsed = parseJson('normalizeFollowupParameters', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (parsed === null) return undefined;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractAssistantFollowupMessageWithNative(finalChatResponse: unknown): Record<string, unknown> | null {
  const capability = 'extractAssistantFollowupMessageJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [finalChatResponse ?? null]);
    const parsed = parseJson('extractAssistantFollowupMessage', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyFollowupDeltaPlanWithNative(input: {
  adapterContext: Record<string, unknown>;
  finalChatResponse: Record<string, unknown>;
  seed: Record<string, unknown>;
  injection: Record<string, unknown>;
}): Record<string, unknown> | null {
  const capability = 'applyFollowupDeltaPlanJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  try {
    const raw = invokeNativeStringCapabilityWithJsonArgs(capability, [input]);
    const parsed = parseJson('applyFollowupDeltaPlan', raw);
    if (parsed === JSON_PARSE_FAILED) return fail('invalid json');
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildServertoolToolOutputPayloadWithNative(input: {
  base: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  arguments?: string;
  content: unknown;
  stripToolCallName?: string;
}): Record<string, unknown> {
  const capability = 'buildServertoolToolOutputPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    if (isNativeDisabledByEnv()) {
      return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail();
    }
    const raw = fn(JSON.stringify(input));
    if (typeof raw !== 'string') {
      return fail('non-string result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildServertoolHandlerErrorToolOutputPayloadWithNative(input: {
  base: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  message: string;
  retryable?: boolean;
}): Record<string, unknown> {
  const capability = 'buildServertoolHandlerErrorToolOutputPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  try {
    if (isNativeDisabledByEnv()) {
      return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail();
    }
    const raw = fn(JSON.stringify(input));
    if (typeof raw !== 'string') {
      return fail('non-string result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function collectServertoolAdditionalClientToolCallsWithNative(input: {
  base: Record<string, unknown>;
  projectedToolCallId: string;
}): unknown[] {
  const capability = 'collectServertoolAdditionalClientToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  try {
    if (isNativeDisabledByEnv()) {
      return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail();
    }
    const raw = fn(JSON.stringify(input));
    if (typeof raw !== 'string') {
      return fail('non-string result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isServertoolClientExecCliProjectionToolCallWithNative(input: {
  executionMode?: unknown;
}): boolean {
  const capability = 'isServertoolClientExecCliProjectionToolCallJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  try {
    if (isNativeDisabledByEnv()) {
      return fail('native disabled');
    }
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail();
    }
    const raw = fn(JSON.stringify(input));
    if (raw === 'true') {
      return true;
    }
    if (raw === 'false') {
      return false;
    }
    return fail(`invalid bool: ${String(raw)}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

// ── Web Search Pure Blocks ────────────────────────────────────────────

function invokeWebSearchNative(capability: string, args: unknown[]): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const encoded = args.map((a) => encodeJsonArg(capability, a));
    const raw = fn(...encoded);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
      return fail(String((raw as { message: unknown }).message));
    }
    if (typeof raw !== 'string') return fail('non-string result');
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeWebSearchNativeRaw(capability: string, args: unknown[]): string {
  return invokeNativeStringCapability(capability, args);
}

export function webSearchIsGeminiEngineWithNative(providerKey: string): boolean {
  return invokeWebSearchNative('webSearchIsGeminiEngine', [providerKey]) === 'true';
}

export function webSearchIsQwenEngineWithNative(providerKey: string): boolean {
  return invokeWebSearchNative('webSearchIsQwenEngine', [providerKey]) === 'true';
}

export function webSearchIsGlmEngineWithNative(providerKey: string): boolean {
  return invokeWebSearchNative('webSearchIsGlmEngine', [providerKey]) === 'true';
}

export function webSearchNormalizeResultCountWithNative(valueJson: string): number {
  const raw = invokeWebSearchNativeRaw('webSearchNormalizeResultCountJson', [valueJson]);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return failNativeRequired<number>('webSearchNormalizeResultCountJson', 'invalid result');
  }
  return n;
}

export function webSearchBuildSystemPromptWithNative(targetCount: number): string {
  const capability = 'webSearchBuildSystemPrompt';
  return invokeNativeStringCapability(capability, [targetCount]);
}

export function webSearchSanitizeBackendErrorWithNative(message: string): string {
  return invokeWebSearchNative('webSearchSanitizeBackendError', [message]);
}

export function webSearchCollectHitsWithNative(chatResponseJson: string, targetCount: number): string {
  return invokeWebSearchNativeRaw('webSearchCollectHitsJson', [chatResponseJson, targetCount]);
}

export function webSearchFormatHitsSummaryWithNative(hitsJson: string): string {
  return invokeWebSearchNativeRaw('webSearchFormatHitsSummaryJson', [hitsJson]);
}

export function webSearchLimitHitsWithNative(hitsJson: string): string {
  return invokeWebSearchNativeRaw('webSearchLimitHitsJson', [hitsJson]);
}

export function webSearchExtractAssistantMessageWithNative(chatResponseJson: string): string {
  return invokeWebSearchNativeRaw('webSearchExtractAssistantMessageJson', [chatResponseJson]);
}

export function webSearchBuildToolMessagesWithNative(chatResponseJson: string): string {
  return invokeWebSearchNativeRaw('webSearchBuildToolMessagesJson', [chatResponseJson]);
}

// ── Vision Pure Blocks ────────────────────────────────────────────────

export function visionBuildAnalysisPayloadWithNative(sourceJson: string): string {
  if (isNativeDisabledByEnv()) return 'null';
  const fn = readNativeFunction('visionBuildAnalysisPayloadJson');
  if (!fn) return 'null';
  try {
    const raw = fn(sourceJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch { return 'null'; }
}

export function visionBuildPinnedMetadataWithNative(adapterContextJson: string, payloadJson: string): string {
  if (isNativeDisabledByEnv()) return 'null';
  const fn = readNativeFunction('visionBuildPinnedMetadataJson');
  if (!fn) return 'null';
  try {
    const raw = fn(adapterContextJson, payloadJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch { return 'null'; }
}

export function visionExtractOriginalUserPromptWithNative(messagesJson: string): string {
  if (isNativeDisabledByEnv()) return '';
  const fn = readNativeFunction('visionExtractOriginalUserPromptJson');
  if (!fn) return '';
  try {
    const raw = fn(messagesJson);
    return typeof raw === 'string' ? raw : '';
  } catch { return ''; }
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
