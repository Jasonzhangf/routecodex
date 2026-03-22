import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';

import { readNativeFunction, safeStringify } from './native-hub-bridge-action-semantics-shared.js';

import {
  parseApplyBridgeCaptureToolResultsOutput,
  parseApplyBridgeEnsureToolPlaceholdersOutput,
  parseApplyBridgeNormalizeHistoryOutput,
  parseBridgeInputToChatOutput,
  parseEnsureMessagesArrayOutput
} from './native-hub-bridge-action-semantics-parsers.js';

import type {
  NativeApplyBridgeCaptureToolResultsInput,
  NativeApplyBridgeCaptureToolResultsOutput,
  NativeApplyBridgeEnsureToolPlaceholdersInput,
  NativeApplyBridgeEnsureToolPlaceholdersOutput,
  NativeApplyBridgeNormalizeHistoryInput,
  NativeApplyBridgeNormalizeHistoryOutput,
  NativeBridgeInputToChatInput,
  NativeBridgeInputToChatOutput,
  NativeEnsureMessagesArrayInput,
  NativeEnsureMessagesArrayOutput,
  NativeSerializeToolArgumentsInput,
  NativeSerializeToolOutputInput
} from './native-hub-bridge-action-semantics-types.js';

export function applyBridgeNormalizeHistoryWithNative(
  input: NativeApplyBridgeNormalizeHistoryInput
): NativeApplyBridgeNormalizeHistoryOutput {
  const capability = 'applyBridgeNormalizeHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeNormalizeHistoryOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    tools: input.tools
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeNormalizeHistoryOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeCaptureToolResultsWithNative(
  input: NativeApplyBridgeCaptureToolResultsInput
): NativeApplyBridgeCaptureToolResultsOutput {
  const capability = 'applyBridgeCaptureToolResultsJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeCaptureToolResultsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    capturedToolResults: input.capturedToolResults,
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
    const parsed = parseApplyBridgeCaptureToolResultsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeEnsureToolPlaceholdersWithNative(
  input: NativeApplyBridgeEnsureToolPlaceholdersInput
): NativeApplyBridgeEnsureToolPlaceholdersOutput {
  const capability = 'applyBridgeEnsureToolPlaceholdersJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeEnsureToolPlaceholdersOutput>(capability, reason);
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
    capturedToolResults: input.capturedToolResults,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeEnsureToolPlaceholdersOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function convertBridgeInputToChatMessagesWithNative(
  input: NativeBridgeInputToChatInput
): NativeBridgeInputToChatOutput {
  const capability = 'convertBridgeInputToChatMessagesJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeInputToChatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    input: input.input,
    tools: input.tools,
    toolResultFallbackText: input.toolResultFallbackText,
    normalizeFunctionName: input.normalizeFunctionName
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBridgeInputToChatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function coerceBridgeRoleWithNative(role: unknown): string {
  const capability = 'coerceBridgeRoleJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ role });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function serializeToolOutputWithNative(input: NativeSerializeToolOutputInput): string | null {
  const capability = 'serializeToolOutputJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ output: input.output });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string') {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' || parsed === null ? (parsed as string | null) : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function serializeToolArgumentsWithNative(input: NativeSerializeToolArgumentsInput): string {
  const capability = 'serializeToolArgumentsJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ args: input.args });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureMessagesArrayWithNative(
  input: NativeEnsureMessagesArrayInput
): NativeEnsureMessagesArrayOutput {
  const capability = 'ensureMessagesArrayJson';
  const fail = (reason?: string) => failNativeRequired<NativeEnsureMessagesArrayOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ state: input.state });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseEnsureMessagesArrayOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
