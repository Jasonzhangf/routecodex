import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStandardizedToChatInput,
  NativeReqOutboundStage3CompatInput,
  NativeReqOutboundStage3CompatOutput,
  NativeRespInboundStage3CompatInput,
  NativeRespInboundStage3CompatOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';
import {
  parseRecord,
  parseReqOutboundCompatOutput,
  parseJsonObject
} from './native-hub-pipeline-req-outbound-semantics-parsers.js';

export type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStandardizedToChatInput,
  NativeReqOutboundStage3CompatInput,
  NativeReqOutboundStage3CompatOutput,
  NativeRespInboundStage3CompatInput,
  NativeRespInboundStage3CompatOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';

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
