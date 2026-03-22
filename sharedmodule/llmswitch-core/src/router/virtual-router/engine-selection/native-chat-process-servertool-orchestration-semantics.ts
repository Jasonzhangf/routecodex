import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

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

export type NativeChatServerToolBundlePlan = {
  webSearch: NativeChatWebSearchPlan;
  clock: NativeChatClockPlan;
  continueExecution: NativeContinueExecutionPlan;
};

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
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
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
  } catch {
    return null;
  }
}

function parseClockPlan(raw: string): NativeChatClockPlan | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.shouldInject !== 'boolean') {
      return null;
    }
    return { shouldInject: row.shouldInject };
  } catch {
    return null;
  }
}

function parseContinueExecutionPlan(raw: string): NativeContinueExecutionPlan | null {
  return parseClockPlan(raw);
}

function parseContinueDirectiveInjection(raw: string): NativeContinueDirectiveInjection | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
  } catch {
    return null;
  }
}

function parseServerToolBundlePlan(raw: string): NativeChatServerToolBundlePlan | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
  } catch {
    return null;
  }
}

function parseProviderResponseShape(raw: string):
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-chat'
  | 'unknown'
  | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'string') {
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
  } catch {
    return null;
  }
}

function parseReviewOperations(raw: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
    );
  } catch {
    return null;
  }
}

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseStringOrUndefined(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : null;
  } catch {
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
