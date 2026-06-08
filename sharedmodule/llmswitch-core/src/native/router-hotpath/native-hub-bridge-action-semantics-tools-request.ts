import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';

import {
  parseNativeResultOrFail,
  readNativeFunction,
  readNativeJsonResult,
  safeStringify,
  shouldRethrowNativeRawError
} from './native-hub-bridge-action-semantics-shared.js';

import {
  parseAppendLocalImageBlockOnLatestUserInputOutput,
  parseBridgeHistoryOutput,
  parseFilterBridgeInputForUpstreamOutput,
  parseNormalizeBridgeHistorySeedOutput,
  parseOutput,
  parsePrepareResponsesRequestEnvelopeOutput,
  parseResolveResponsesBridgeToolsOutput,
  parseResolveResponsesRequestBridgeDecisionsOutput
} from './native-hub-bridge-action-semantics-parsers.js';

import type {
  NativeAppendLocalImageBlockOnLatestUserInputInput,
  NativeAppendLocalImageBlockOnLatestUserInputOutput,
  NativeApplyBridgeNormalizeToolIdentifiersInput,
  NativeBridgeHistoryInput,
  NativeBridgeHistoryOutput,
  NativeBridgeToolCallIdsInput,
  NativeBridgeToolCallIdsOutput,
  NativeFilterBridgeInputForUpstreamInput,
  NativeFilterBridgeInputForUpstreamOutput,
  NativeNormalizeBridgeHistorySeedOutput,
  NativePrepareResponsesRequestEnvelopeInput,
  NativePrepareResponsesRequestEnvelopeOutput,
  NativeResolveResponsesBridgeToolsInput,
  NativeResolveResponsesBridgeToolsOutput,
  NativeResolveResponsesRequestBridgeDecisionsInput,
  NativeResolveResponsesRequestBridgeDecisionsOutput
} from './native-hub-bridge-action-semantics-types.js';

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
    return parseNativeResultOrFail(capability, raw, parseOutput);
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
    return parseNativeResultOrFail(capability, raw, parseOutput);
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
    return parseNativeResultOrFail(capability, raw, parseBridgeHistoryOutput);
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
    return parseNativeResultOrFail(capability, raw, parseNormalizeBridgeHistorySeedOutput);
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
    return parseNativeResultOrFail(capability, raw, parseResolveResponsesBridgeToolsOutput);
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
    return parseNativeResultOrFail(capability, raw, parseResolveResponsesRequestBridgeDecisionsOutput);
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
    return parseNativeResultOrFail(capability, raw, parseFilterBridgeInputForUpstreamOutput);
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
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
    return parseNativeResultOrFail(capability, raw, parsePrepareResponsesRequestEnvelopeOutput);
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
    return parseNativeResultOrFail(capability, raw, parseAppendLocalImageBlockOnLatestUserInputOutput);
  } catch (error) {
    if (shouldRethrowNativeRawError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
