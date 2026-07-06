import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';

import {
  parseNativeJsonValueOrFail,
  readNativeFunction,
  readNativeJsonResult,
  safeStringify,
  shouldRethrowNativeRawError
} from './native-hub-bridge-action-semantics-shared.js';

export interface NativeApplyBridgeNormalizeHistoryInput {
  messages: unknown[];
  tools?: Array<Record<string, unknown>>;
  allowPendingTerminalToolCall?: boolean;
}

export interface NativeApplyBridgeNormalizeHistoryOutput {
  messages: unknown[];
  bridgeHistory?: Record<string, unknown>;
}

export interface NativeApplyBridgeCaptureToolResultsInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeCaptureToolResultsOutput {
  capturedToolResults?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureToolPlaceholdersInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  messages: unknown[];
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureToolPlaceholdersOutput {
  messages: unknown[];
  toolOutputs?: Array<Record<string, unknown>>;
}

export interface NativeBridgeInputToChatInput {
  input: unknown[];
  tools?: Array<Record<string, unknown>>;
  toolResultFallbackText?: string;
  normalizeFunctionName?: string;
  allowPendingTerminalToolCall?: boolean;
  allowOrphanToolResult?: boolean;
}

export interface NativeBridgeInputToChatOutput {
  messages: Array<Record<string, unknown>>;
}

export interface NativeCoerceBridgeRoleInput {
  role: unknown;
}

export interface NativeSerializeToolArgumentsInput {
  args?: unknown;
}

export interface NativeSerializeToolOutputInput {
  output?: unknown;
}

export interface NativeEnsureMessagesArrayInput {
  state?: unknown;
}

export interface NativeEnsureMessagesArrayOutput {
  messages: Array<Record<string, unknown>>;
}

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
    tools: input.tools,
    allowPendingTerminalToolCall: input.allowPendingTerminalToolCall
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeNormalizeHistoryOutput>(capability, raw, 'parseApplyBridgeNormalizeHistoryOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeCaptureToolResultsOutput>(capability, raw, 'parseApplyBridgeCaptureToolResultsOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeEnsureToolPlaceholdersOutput>(capability, raw, 'parseApplyBridgeEnsureToolPlaceholdersOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    normalizeFunctionName: input.normalizeFunctionName,
    allowPendingTerminalToolCall: input.allowPendingTerminalToolCall,
    allowOrphanToolResult: input.allowOrphanToolResult
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeBridgeInputToChatOutput>(capability, raw, 'parseBridgeInputToChatOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' || parsed === null ? (parsed as string | null) : fail('invalid payload');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeEnsureMessagesArrayOutput>(capability, raw, 'parseEnsureMessagesArrayOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
