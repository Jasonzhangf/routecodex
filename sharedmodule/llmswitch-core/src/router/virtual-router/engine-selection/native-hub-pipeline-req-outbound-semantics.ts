import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import type { JsonObject } from '../../../conversion/hub/types/json.js';
import type {
  NativeReqOutboundContextMergePlanInput,
  NativeReqOutboundFormatBuildInput,
  NativeReqOutboundContextMergePlan,
  NativeReqOutboundContextSnapshotPatchInput,
  NativeReqOutboundContextSnapshotPatch,
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStandardizedToChatInput,
  NativeReqOutboundStage3CompatInput,
  NativeReqOutboundStage3CompatOutput,
  NativeRespInboundStage3CompatInput,
  NativeRespInboundStage3CompatOutput,
  NativeToolSessionCompatInput,
  NativeToolSessionCompatOutput,
  NativeToolSessionHistoryUpdateInput,
  NativeToolSessionHistoryUpdateOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';
import {
  parseRecord,
  parseReqOutboundContextMergePlan,
  parseReqOutboundFormatBuildOutput,
  parseReqOutboundContextSnapshotPatch,
  parseReqOutboundCompatOutput,
  parseToolSessionCompatOutput,
  parseToolSessionHistoryUpdateOutput,
  parseJsonObject,
  parseBoolean
} from './native-hub-pipeline-req-outbound-semantics-parsers.js';

export type {
  NativeReqOutboundContextMergePlanInput,
  NativeReqOutboundFormatBuildInput,
  NativeReqOutboundContextMergePlan,
  NativeReqOutboundContextSnapshotPatchInput,
  NativeReqOutboundContextSnapshotPatch,
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStandardizedToChatInput,
  NativeReqOutboundStage3CompatInput,
  NativeReqOutboundStage3CompatOutput,
  NativeRespInboundStage3CompatInput,
  NativeRespInboundStage3CompatOutput,
  NativeToolSessionCompatInput,
  NativeToolSessionCompatOutput,
  NativeToolSessionHistoryUpdateInput,
  NativeToolSessionHistoryUpdateOutput
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

export function resolveReqOutboundContextMergePlanWithNative(
  input: NativeReqOutboundContextMergePlanInput
): NativeReqOutboundContextMergePlan {
  const capability = 'resolveReqOutboundContextMergePlanJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundContextMergePlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveReqOutboundContextMergePlanJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundContextMergePlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildReqOutboundFormatPayloadWithNative(
  input: NativeReqOutboundFormatBuildInput
): JsonObject {
  const capability = 'buildFormatRequestJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify({
    formatEnvelope: input.formatEnvelope,
    protocol: input.protocol
  });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundFormatBuildOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyReqOutboundContextSnapshotWithNative(
  input: NativeReqOutboundContextSnapshotPatchInput
): NativeReqOutboundContextSnapshotPatch {
  const capability = 'applyReqOutboundContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundContextSnapshotPatch>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('applyReqOutboundContextSnapshotJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundContextSnapshotPatch(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
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
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
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
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeToolSessionMessagesWithNative(
  input: NativeToolSessionCompatInput
): NativeToolSessionCompatOutput {
  const capability = 'normalizeToolSessionMessagesJson';
  const fail = (reason?: string) => failNativeRequired<NativeToolSessionCompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolSessionCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function updateToolSessionHistoryWithNative(
  input: NativeToolSessionHistoryUpdateInput
): NativeToolSessionHistoryUpdateOutput {
  const capability = 'updateToolSessionHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeToolSessionHistoryUpdateOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolSessionHistoryUpdateOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
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
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJsonObject(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
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
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson, adapterContextJson);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length) {
        return fail(message.trim());
      }
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return (parsed as JsonObject | null) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function shouldAttachReqOutboundContextSnapshotWithNative(
  hasSnapshot: boolean,
  contextMetadataKey: string | undefined
): boolean {
  const capability = 'shouldAttachReqOutboundContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('shouldAttachReqOutboundContextSnapshotJson');
  if (!fn) {
    return fail();
  }
  try {
    const contextMetadataKeyJson = JSON.stringify(contextMetadataKey ?? null);
    if (typeof contextMetadataKeyJson !== 'string') {
      return fail('json stringify failed');
    }
    const raw = fn(hasSnapshot, contextMetadataKeyJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
