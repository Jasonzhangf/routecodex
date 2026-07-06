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

export interface NativeBridgeToolCallIdsInput {
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  idPrefix?: string;
}

export interface NativeBridgeToolCallIdsOutput {
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
}

export interface NativeApplyBridgeNormalizeToolIdentifiersInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  protocol?: string;
  moduleType?: string;
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  idPrefix?: string;
}

export interface NativeBridgeHistoryInput {
  messages: unknown[];
  tools?: Array<Record<string, unknown>>;
  allowPendingTerminalToolCall?: boolean;
}

export interface NativeBridgeHistoryOutput {
  input: unknown[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

export interface NativeNormalizeBridgeHistorySeedOutput {
  input: unknown[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

export interface NativeResolveResponsesBridgeToolsInput {
  originalTools?: Array<Record<string, unknown>>;
  chatTools?: Array<Record<string, unknown>>;
  allowBuiltinWebSearch?: boolean;
  hasServerSideWebSearch?: boolean;
  passthroughKeys?: string[];
  request?: Record<string, unknown>;
}

export interface NativeResolveResponsesBridgeToolsOutput {
  mergedTools?: Array<Record<string, unknown>>;
  request?: Record<string, unknown>;
}

export interface NativeResolveResponsesRequestBridgeDecisionsInput {
  context?: Record<string, unknown>;
  requestMetadata?: Record<string, unknown>;
  envelopeMetadata?: Record<string, unknown>;
  bridgeMetadata?: Record<string, unknown>;
  extraBridgeHistory?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
}

export interface NativeResolveResponsesRequestBridgeDecisionsOutput {
  forceWebSearch: boolean;
  allowBuiltinWebSearch: boolean;
  toolCallIdStyle?: 'fc' | 'preserve';
  historySeed?: NativeBridgeHistoryOutput;
  previousResponseId?: string;
}

export interface NativeFilterBridgeInputForUpstreamInput {
  input: unknown[];
  allowToolCallId?: boolean;
}

export interface NativeFilterBridgeInputForUpstreamOutput {
  input: Array<Record<string, unknown>>;
}

export interface NativeSanitizeCapturedResponsesInputInput {
  input: unknown[];
}

export interface NativeSanitizeCapturedResponsesInputOutput {
  input: Array<Record<string, unknown>>;
}

export interface NativePickResponsesRequestParametersInput {
  payload?: Record<string, unknown>;
  streamHint?: boolean;
}

export interface NativePickResponsesRequestParametersOutput {
  [key: string]: unknown;
}

export interface NativeResponsesValueInput {
  value?: Record<string, unknown>;
}

export interface NativeStripResponsesToolControlFieldsInput extends NativeResponsesValueInput {
  nestedExtraFields?: boolean;
}

export interface NativeMergeRetainedResponsesRequestParametersInput {
  request?: Record<string, unknown>;
  retainedParameters?: Record<string, unknown>;
}

export interface NativePrepareResponsesRequestEnvelopeInput {
  request: Record<string, unknown>;
  extraSystemInstruction?: unknown;
  combinedSystemInstruction?: unknown;
  reasoningInstructionSegments?: unknown;
  chatParameters?: unknown;
  chatStream?: unknown;
  chatParametersStream?: unknown;
  stripHostFields?: boolean;
}

export interface NativePrepareResponsesRequestEnvelopeOutput {
  request: Record<string, unknown>;
}

export interface NativeAppendLocalImageBlockOnLatestUserInputInput {
  messages: unknown[];
}

export interface NativeAppendLocalImageBlockOnLatestUserInputOutput {
  messages: Array<Record<string, unknown>>;
}

export function normalizeBridgeToolCallIdsWithNative(
  input: NativeBridgeToolCallIdsInput
): NativeBridgeToolCallIdsOutput {
  const capability = 'normalizeBridgeToolCallIdsJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeToolCallIdsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    rawRequest: input.rawRequest,
    capturedToolResults: input.capturedToolResults,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeBridgeToolCallIdsOutput>(capability, raw, 'parseOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeNormalizeToolIdentifiersWithNative(
  input: NativeApplyBridgeNormalizeToolIdentifiersInput
): NativeBridgeToolCallIdsOutput {
  const capability = 'applyBridgeNormalizeToolIdentifiersJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeToolCallIdsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    protocol: input.protocol,
    moduleType: input.moduleType,
    messages: input.messages,
    rawRequest: input.rawRequest,
    capturedToolResults: input.capturedToolResults,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeBridgeToolCallIdsOutput>(capability, raw, 'parseOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildBridgeHistoryWithNative(
  input: NativeBridgeHistoryInput
): NativeBridgeHistoryOutput {
  const capability = 'buildBridgeHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeHistoryOutput>(capability, reason);
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
    return parseNativeJsonValueOrFail<NativeBridgeHistoryOutput>(capability, raw, 'parseBridgeHistoryOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeBridgeHistorySeedWithNative(
  seed: Record<string, unknown>
): NativeNormalizeBridgeHistorySeedOutput {
  const capability = 'normalizeBridgeHistorySeedJson';
  const fail = (reason?: string) => failNativeRequired<NativeNormalizeBridgeHistorySeedOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(seed);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeNormalizeBridgeHistorySeedOutput>(capability, raw, 'parseNormalizeBridgeHistorySeedOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveResponsesBridgeToolsWithNative(
  input: NativeResolveResponsesBridgeToolsInput
): NativeResolveResponsesBridgeToolsOutput {
  const capability = 'resolveResponsesBridgeToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeResolveResponsesBridgeToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    originalTools: input.originalTools,
    chatTools: input.chatTools,
    allowBuiltinWebSearch: input.allowBuiltinWebSearch,
    hasServerSideWebSearch: input.hasServerSideWebSearch,
    passthroughKeys: input.passthroughKeys,
    request: input.request
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeResolveResponsesBridgeToolsOutput>(capability, raw, 'parseResolveResponsesBridgeToolsOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveResponsesRequestBridgeDecisionsWithNative(
  input: NativeResolveResponsesRequestBridgeDecisionsInput
): NativeResolveResponsesRequestBridgeDecisionsOutput {
  const capability = 'resolveResponsesRequestBridgeDecisionsJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeResolveResponsesRequestBridgeDecisionsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    context: input.context,
    requestMetadata: input.requestMetadata,
    envelopeMetadata: input.envelopeMetadata,
    bridgeMetadata: input.bridgeMetadata,
    extraBridgeHistory: input.extraBridgeHistory,
    requestSemantics: input.requestSemantics
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeResolveResponsesRequestBridgeDecisionsOutput>(capability, raw, 'parseResolveResponsesRequestBridgeDecisionsOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function filterBridgeInputForUpstreamWithNative(
  input: NativeFilterBridgeInputForUpstreamInput
): NativeFilterBridgeInputForUpstreamOutput {
  const capability = 'filterBridgeInputForUpstreamJson';
  const fail = (reason?: string) => failNativeRequired<NativeFilterBridgeInputForUpstreamOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    input: input.input,
    allowToolCallId: input.allowToolCallId
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeFilterBridgeInputForUpstreamOutput>(capability, raw, 'parseFilterBridgeInputForUpstreamOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeCapturedResponsesInputWithNative(
  input: NativeSanitizeCapturedResponsesInputInput
): NativeSanitizeCapturedResponsesInputOutput {
  const capability = 'sanitizeCapturedResponsesInputJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeSanitizeCapturedResponsesInputOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    input: input.input
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeSanitizeCapturedResponsesInputOutput>(capability, raw, 'parseSanitizeCapturedResponsesInputOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeNullableRecordCapability(
  capability: string,
  input: unknown,
  parseStage: string
): Record<string, unknown> | undefined {
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    const parsed = parseNativeJsonValueOrFail<Record<string, unknown> | null>(capability, raw, parseStage);
    return parsed ?? undefined;
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function pickResponsesRequestParametersWithNative(
  input: NativePickResponsesRequestParametersInput
): NativePickResponsesRequestParametersOutput | undefined {
  return invokeNullableRecordCapability('pickResponsesRequestParametersJson', input, 'parsePickResponsesRequestParametersOutput');
}

export function pickResponsesToolPassthroughFieldsWithNative(
  input: NativeResponsesValueInput
): Record<string, unknown> | undefined {
  return invokeNullableRecordCapability('pickResponsesToolPassthroughFieldsJson', input, 'parsePickResponsesToolPassthroughFieldsOutput');
}

export function pickResponsesBridgeDecisionMetadataWithNative(
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return input
    ? invokeNullableRecordCapability('pickResponsesBridgeDecisionMetadataJson', { metadata: input }, 'parsePickResponsesBridgeDecisionMetadataOutput')
    : undefined;
}

export function extractResponsesMetadataExtraFieldsWithNative(
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return input
    ? invokeNullableRecordCapability('extractResponsesMetadataExtraFieldsJson', { metadata: input }, 'parseExtractResponsesMetadataExtraFieldsOutput')
    : undefined;
}

export function stripResponsesToolControlFieldsWithNative(
  input: NativeStripResponsesToolControlFieldsInput
): Record<string, unknown> | undefined {
  return invokeNullableRecordCapability('stripResponsesToolControlFieldsJson', input, 'parseStripResponsesToolControlFieldsOutput');
}

export function buildSlimResponsesBridgeContextWithNative(
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return input
    ? invokeNullableRecordCapability('buildSlimResponsesBridgeContextJson', input, 'parseBuildSlimResponsesBridgeContextOutput')
    : undefined;
}

export function mergeRetainedResponsesRequestParametersWithNative(
  input: NativeMergeRetainedResponsesRequestParametersInput
): Record<string, unknown> {
  return invokeNullableRecordCapability('mergeRetainedResponsesRequestParametersJson', input, 'parseMergeRetainedResponsesRequestParametersOutput') ?? {};
}

export function unwrapResponsesDataWithNative(
  input: NativeResponsesValueInput
): Record<string, unknown> {
  const capability = 'unwrapResponsesDataJson';
  const result = invokeNullableRecordCapability(capability, input, 'parseUnwrapResponsesDataOutput');
  if (!result) {
    return failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
  }
  return result;
}

export function prepareResponsesRequestEnvelopeWithNative(
  input: NativePrepareResponsesRequestEnvelopeInput
): NativePrepareResponsesRequestEnvelopeOutput {
  const capability = 'prepareResponsesRequestEnvelopeJson';
  const fail = (reason?: string) => failNativeRequired<NativePrepareResponsesRequestEnvelopeOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
    const payloadJson = safeStringify({
    request: input.request,
    extraSystemInstruction: input.extraSystemInstruction,
    combinedSystemInstruction: input.combinedSystemInstruction,
    reasoningInstructionSegments: input.reasoningInstructionSegments,
    chatParameters: input.chatParameters,
    chatStream: input.chatStream,
    chatParametersStream: input.chatParametersStream,
    stripHostFields: input.stripHostFields
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativePrepareResponsesRequestEnvelopeOutput>(capability, raw, 'parsePrepareResponsesRequestEnvelopeOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function appendLocalImageBlockOnLatestUserInputWithNative(
  input: NativeAppendLocalImageBlockOnLatestUserInputInput
): NativeAppendLocalImageBlockOnLatestUserInputOutput {
  const capability = 'appendLocalImageBlockOnLatestUserInputJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeAppendLocalImageBlockOnLatestUserInputOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = readNativeJsonResult(capability, fn(payloadJson));
    return parseNativeJsonValueOrFail<NativeAppendLocalImageBlockOnLatestUserInputOutput>(capability, raw, 'parseAppendLocalImageBlockOnLatestUserInputOutput');
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
