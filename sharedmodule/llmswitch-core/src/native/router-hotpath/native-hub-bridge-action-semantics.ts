
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


// Inlined from retired native-hub-bridge-action-semantics-tools-request.ts
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


// Inlined from retired native-hub-bridge-action-semantics-tools-core.ts
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


// Inlined from retired native-hub-bridge-action-semantics-tools-post.ts
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
