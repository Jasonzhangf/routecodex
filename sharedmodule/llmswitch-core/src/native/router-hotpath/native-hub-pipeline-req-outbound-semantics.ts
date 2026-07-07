import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { formatUnknownError } from './native-hub-pipeline-resp-semantics-shared.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';

export interface NativeReqOutboundCompatAdapterContextInput {
  __rt?: Record<string, unknown>;
  compatibilityProfile?: string;
  providerProtocol?: string;
  providerId?: string;
  providerKey?: string;
  runtimeKey?: string;
  requestId?: string;
  clientRequestId?: string;
  groupRequestId?: string;
  sessionId?: string;
  conversationId?: string;
  entryEndpoint?: string;
  routeId?: string;
  capturedChatRequest?: JsonObject;
  deepseek?: Record<string, unknown>;
  anthropicThinkingConfig?: Record<string, unknown>;
  anthropicThinking?: string;
  anthropicThinkingBudgets?: Record<string, unknown>;
  estimatedInputTokens?: number;
  modelId?: string;
  clientModelId?: string;
  originalModelId?: string;
}

export interface NativeReqOutboundStandardizedToChatInput {
  request: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
}

export interface NativeReqOutboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export interface NativeReqOutboundStage3CompatOutput {
  payload: JsonObject;
  appliedProfile?: string;
  nativeApplied: boolean;
}

export interface NativeRespInboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export type NativeRespInboundStage3CompatOutput = NativeReqOutboundStage3CompatOutput;

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-outbound-semantics.parse-failed');

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

function logNativeReqOutboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-outbound-semantics] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqOutboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseReqOutboundCompatOutput(raw: string): NativeReqOutboundStage3CompatOutput | null {
  const row = parseRecord(raw, 'parseReqOutboundCompatOutput');
  return row as unknown as NativeReqOutboundStage3CompatOutput | null;
}

function parseJsonObject(raw: string): JsonObject | null {
  const parsed = parseJson('parseJsonObject', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

function throwNativeExecutionError(capability: string, reason?: string): never {
  throw new Error(
    `[virtual-router-native-hotpath] native ${capability} execution failed${reason ? `: ${reason}` : ''}`
  );
}

function rethrowNativeStageError(capability: string, error: unknown): never {
  if (error instanceof Error) {
    throw error;
  }
  return throwNativeExecutionError(capability, String(error ?? 'unknown'));
}

export function runReqOutboundStage3CompatWithNative(
  input: NativeReqOutboundStage3CompatInput
): NativeReqOutboundStage3CompatOutput {
  const capability = 'runReqOutboundStage3CompatJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundStage3CompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('runReqOutboundStage3CompatJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return throwNativeExecutionError(capability, 'json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return throwNativeExecutionError(capability, 'empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? throwNativeExecutionError(capability, 'invalid payload');
  } catch (error) {
    return rethrowNativeStageError(capability, error);
  }
}

export function runRespInboundStage3CompatWithNative(
  input: NativeRespInboundStage3CompatInput
): NativeRespInboundStage3CompatOutput {
  const capability = 'runRespInboundStage3CompatJson';
  const fail = (reason?: string) => failNativeRequired<NativeRespInboundStage3CompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('runRespInboundStage3CompatJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return throwNativeExecutionError(capability, 'json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return throwNativeExecutionError(capability, 'empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? throwNativeExecutionError(capability, 'invalid payload');
  } catch (error) {
    return rethrowNativeStageError(capability, error);
  }
}

export function buildNativeReqOutboundCompatAdapterContextWithNative(input: {
  metadataCenterSnapshot?: unknown;
}): NativeReqOutboundCompatAdapterContextInput {
  const capability = 'buildNativeReqOutboundCompatAdapterContextJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundCompatAdapterContextInput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return throwNativeExecutionError(capability, 'json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return throwNativeExecutionError(capability, 'empty result');
    }
    const parsed = parseRecord(raw);
    return (parsed as NativeReqOutboundCompatAdapterContextInput | null)
      ?? throwNativeExecutionError(capability, 'invalid payload');
  } catch (error) {
    return rethrowNativeStageError(capability, error);
  }
}

export function applyClaudeThinkingToolSchemaCompatWithNative(
  payload: JsonObject
): JsonObject {
  const capability = 'applyClaudeThinkingToolSchemaCompatJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    return throwNativeExecutionError(capability, 'json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return throwNativeExecutionError(capability, 'empty result');
    }
    const parsed = parseJsonObject(raw);
    return parsed ?? throwNativeExecutionError(capability, 'invalid payload');
  } catch (error) {
    return rethrowNativeStageError(capability, error);
  }
}

export function standardizedToChatEnvelopeWithNative(
  input: NativeReqOutboundStandardizedToChatInput
): JsonObject {
  const capability = 'standardizedToChatEnvelopeJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(input.request);
  const adapterContextJson = safeStringify(input.adapterContext);
  if (!requestJson || !adapterContextJson) {
    return throwNativeExecutionError(capability, 'json stringify failed');
  }
  try {
    const raw = fn(requestJson, adapterContextJson);
    if (raw instanceof Error) {
      return throwNativeExecutionError(capability, raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length) {
        return throwNativeExecutionError(capability, message.trim());
      }
    }
    if (typeof raw !== 'string' || !raw) {
      return throwNativeExecutionError(capability, 'empty result');
    }
    const parsed = parseRecord(raw);
    return (parsed as JsonObject | null) ?? throwNativeExecutionError(capability, 'invalid payload');
  } catch (error) {
    return rethrowNativeStageError(capability, error);
  }
}
