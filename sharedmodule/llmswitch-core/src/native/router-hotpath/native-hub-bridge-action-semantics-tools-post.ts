import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';

import {
  parseNativeJsonObjectOrFail,
  parseNativeJsonValueOrFail,
  readNativeFunction,
  readNativeJsonResult,
  safeStringify,
  shouldRethrowNativeRawError
} from './native-hub-bridge-action-semantics-shared.js';

export interface NativeEnsureBridgeOutputFieldsInput {
  messages: unknown[];
  toolFallback?: string;
  assistantFallback?: string;
}

export interface NativeEnsureBridgeOutputFieldsOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeMetadataActionInput {
  actionName: string;
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  options?: Record<string, unknown>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeMetadataActionOutput {
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeReasoningExtractInput {
  messages: unknown[];
  dropFromContent?: boolean;
  idPrefixBase?: string;
}

export interface NativeApplyBridgeReasoningExtractOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeResponsesOutputReasoningInput {
  messages: unknown[];
  rawResponse?: Record<string, unknown>;
  idPrefix?: string;
}

export interface NativeApplyBridgeResponsesOutputReasoningOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeInjectSystemInstructionInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  options?: Record<string, unknown>;
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
}

export interface NativeApplyBridgeInjectSystemInstructionOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeEnsureSystemInstructionInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  messages: unknown[];
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureSystemInstructionOutput {
  messages: unknown[];
  metadata?: Record<string, unknown>;
}

export interface NativeBridgeActionPipelineInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  actions?: Array<{ name: string; options?: Record<string, unknown> }>;
  protocol?: string;
  moduleType?: string;
  requestId?: string;
  state: NativeBridgeActionState;
}

export interface NativeBridgeActionState {
  messages: unknown[];
  input?: unknown[];
  requiredAction?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeNormalizeMessageReasoningToolsOutput {
  message: Record<string, unknown>;
  toolCallsAdded: number;
  cleanedReasoning?: string;
}

export interface NativeHarvestToolsInput {
  signal: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface NativeHarvestToolsOutput {
  deltaEvents: Array<Record<string, unknown>>;
  normalized?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
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
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeEnsureBridgeOutputFieldsOutput>(capability, raw, 'parseEnsureBridgeOutputFieldsOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeMetadataActionOutput>(capability, raw, 'parseApplyBridgeMetadataActionOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeReasoningExtractOutput>(capability, raw, 'parseApplyBridgeReasoningExtractOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeResponsesOutputReasoningOutput>(capability, raw, 'parseApplyBridgeResponsesOutputReasoningOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeInjectSystemInstructionOutput>(capability, raw, 'parseApplyBridgeInjectSystemInstructionOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeApplyBridgeEnsureSystemInstructionOutput>(capability, raw, 'parseApplyBridgeEnsureSystemInstructionOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
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
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeBridgeActionState>(capability, raw, 'parseBridgeActionState');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeMessageReasoningToolsWithNative(
  message: Record<string, unknown>,
  idPrefix?: string
): NativeNormalizeMessageReasoningToolsOutput {
  const existingToolCalls = Array.isArray((message as Record<string, unknown>)?.tool_calls)
    ? (((message as Record<string, unknown>).tool_calls as unknown[]).length > 0)
    : false;
  const existingFunctionCall =
    (message as Record<string, unknown>)?.function_call
    && typeof (message as Record<string, unknown>).function_call === 'object'
    && !Array.isArray((message as Record<string, unknown>).function_call);
  if (existingToolCalls || existingFunctionCall) {
    return {
      message,
      toolCallsAdded: 0
    };
  }
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
    const raw = readNativeJsonResult(capability, fn(messageJson, typeof idPrefix === 'string' && idPrefix.trim().length ? idPrefix.trim() : undefined));
    return parseNativeJsonValueOrFail<NativeNormalizeMessageReasoningToolsOutput>(capability, raw, 'parseNormalizeMessageReasoningToolsOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeChatResponseReasoningToolsWithNative(
  response: Record<string, unknown>,
  idPrefixBase?: string
): Record<string, unknown> {
  const choices = Array.isArray((response as Record<string, unknown>)?.choices)
    ? ((response as Record<string, unknown>).choices as unknown[])
    : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      continue;
    }
    const message =
      (choice as Record<string, unknown>).message
      && typeof (choice as Record<string, unknown>).message === 'object'
      && !Array.isArray((choice as Record<string, unknown>).message)
        ? ((choice as Record<string, unknown>).message as Record<string, unknown>)
        : undefined;
    if (!message) {
      continue;
    }
    const existingToolCalls = Array.isArray(message.tool_calls) ? ((message.tool_calls as unknown[]).length > 0) : false;
    const existingFunctionCall =
      message.function_call
      && typeof message.function_call === 'object'
      && !Array.isArray(message.function_call);
    if (existingToolCalls || existingFunctionCall) {
      return response;
    }
  }
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
    return parseNativeJsonObjectOrFail<Record<string, unknown>>(capability, raw, 'parseRecord');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
