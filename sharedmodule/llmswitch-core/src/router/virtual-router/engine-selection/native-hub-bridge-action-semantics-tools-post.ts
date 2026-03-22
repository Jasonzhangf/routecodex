import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';

import { readNativeFunction, safeStringify } from './native-hub-bridge-action-semantics-shared.js';

import {
  parseApplyBridgeEnsureSystemInstructionOutput,
  parseApplyBridgeInjectSystemInstructionOutput,
  parseApplyBridgeMetadataActionOutput,
  parseApplyBridgeReasoningExtractOutput,
  parseApplyBridgeResponsesOutputReasoningOutput,
  parseBridgeActionState,
  parseEnsureBridgeOutputFieldsOutput,
  parseNormalizeMessageReasoningToolsOutput,
  parseRecord
} from './native-hub-bridge-action-semantics-parsers.js';

import type {
  NativeApplyBridgeEnsureSystemInstructionInput,
  NativeApplyBridgeEnsureSystemInstructionOutput,
  NativeApplyBridgeInjectSystemInstructionInput,
  NativeApplyBridgeInjectSystemInstructionOutput,
  NativeApplyBridgeMetadataActionInput,
  NativeApplyBridgeMetadataActionOutput,
  NativeApplyBridgeReasoningExtractInput,
  NativeApplyBridgeReasoningExtractOutput,
  NativeApplyBridgeResponsesOutputReasoningInput,
  NativeApplyBridgeResponsesOutputReasoningOutput,
  NativeBridgeActionPipelineInput,
  NativeBridgeActionState,
  NativeEnsureBridgeOutputFieldsInput,
  NativeEnsureBridgeOutputFieldsOutput,
  NativeHarvestToolsInput,
  NativeHarvestToolsOutput,
  NativeNormalizeMessageReasoningToolsOutput
} from './native-hub-bridge-action-semantics-types.js';

export function harvestToolsWithNative(input: NativeHarvestToolsInput): NativeHarvestToolsOutput {
  const capability = 'harvestToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeHarvestToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ signal: input.signal, context: input.context });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.deltaEvents)) {
      return fail('invalid payload');
    }
    return row as unknown as NativeHarvestToolsOutput;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureBridgeOutputFieldsWithNative(
  input: NativeEnsureBridgeOutputFieldsInput
): NativeEnsureBridgeOutputFieldsOutput {
  const capability = 'ensureBridgeOutputFieldsJson';
  const fail = (reason?: string) => failNativeRequired<NativeEnsureBridgeOutputFieldsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    toolFallback: input.toolFallback,
    assistantFallback: input.assistantFallback
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseEnsureBridgeOutputFieldsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeMetadataActionWithNative(
  input: NativeApplyBridgeMetadataActionInput
): NativeApplyBridgeMetadataActionOutput {
  const capability = 'applyBridgeMetadataActionJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeMetadataActionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    actionName: input.actionName,
    stage: input.stage,
    options: input.options,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse,
    metadata: input.metadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeMetadataActionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeReasoningExtractWithNative(
  input: NativeApplyBridgeReasoningExtractInput
): NativeApplyBridgeReasoningExtractOutput {
  const capability = 'applyBridgeReasoningExtractJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeReasoningExtractOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    dropFromContent: input.dropFromContent,
    idPrefixBase: input.idPrefixBase
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeReasoningExtractOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeResponsesOutputReasoningWithNative(
  input: NativeApplyBridgeResponsesOutputReasoningInput
): NativeApplyBridgeResponsesOutputReasoningOutput {
  const capability = 'applyBridgeResponsesOutputReasoningJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeResponsesOutputReasoningOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    rawResponse: input.rawResponse,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeResponsesOutputReasoningOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeInjectSystemInstructionWithNative(
  input: NativeApplyBridgeInjectSystemInstructionInput
): NativeApplyBridgeInjectSystemInstructionOutput {
  const capability = 'applyBridgeInjectSystemInstructionJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeInjectSystemInstructionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    options: input.options,
    messages: input.messages,
    rawRequest: input.rawRequest
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeInjectSystemInstructionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeEnsureSystemInstructionWithNative(
  input: NativeApplyBridgeEnsureSystemInstructionInput
): NativeApplyBridgeEnsureSystemInstructionOutput {
  const capability = 'applyBridgeEnsureSystemInstructionJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeEnsureSystemInstructionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    messages: input.messages,
    metadata: input.metadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeEnsureSystemInstructionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runBridgeActionPipelineWithNative(
  input: NativeBridgeActionPipelineInput
): NativeBridgeActionState | null {
  const capability = 'runBridgeActionPipelineJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeActionState>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    actions: input.actions,
    protocol: input.protocol,
    moduleType: input.moduleType,
    requestId: input.requestId,
    state: input.state
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBridgeActionState(raw);
    if (!parsed) {
      return null;
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeMessageReasoningToolsWithNative(
  message: Record<string, unknown>,
  idPrefix?: string
): NativeNormalizeMessageReasoningToolsOutput {
  const capability = 'normalizeMessageReasoningToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeNormalizeMessageReasoningToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messageJson = safeStringify(message);
  if (!messageJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(messageJson, typeof idPrefix === 'string' && idPrefix.trim().length ? idPrefix.trim() : undefined);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeMessageReasoningToolsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeChatResponseReasoningToolsWithNative(
  response: Record<string, unknown>,
  idPrefixBase?: string
): Record<string, unknown> {
  const capability = 'normalizeChatResponseReasoningToolsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response);
  if (!responseJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(
      responseJson,
      typeof idPrefixBase === 'string' && idPrefixBase.trim().length ? idPrefixBase.trim() : undefined
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
