import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';

import { readNativeFunction, safeStringify } from './native-hub-bridge-action-semantics-shared.js';

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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const parsed = parseBridgeHistoryOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeBridgeHistorySeedOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    hasServerSideWebSearch: input.hasServerSideWebSearch,
    passthroughKeys: input.passthroughKeys,
    request: input.request
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResolveResponsesBridgeToolsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResolveResponsesRequestBridgeDecisionsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseFilterBridgeInputForUpstreamOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    contextSystemInstruction: input.contextSystemInstruction,
    extraSystemInstruction: input.extraSystemInstruction,
    metadataSystemInstruction: input.metadataSystemInstruction,
    combinedSystemInstruction: input.combinedSystemInstruction,
    reasoningInstructionSegments: input.reasoningInstructionSegments,
    contextParameters: input.contextParameters,
    chatParameters: input.chatParameters,
    metadataParameters: input.metadataParameters,
    contextStream: input.contextStream,
    metadataStream: input.metadataStream,
    chatStream: input.chatStream,
    chatParametersStream: input.chatParametersStream,
    contextInclude: input.contextInclude,
    metadataInclude: input.metadataInclude,
    contextStore: input.contextStore,
    metadataStore: input.metadataStore,
    stripHostFields: input.stripHostFields,
    contextToolChoice: input.contextToolChoice,
    metadataToolChoice: input.metadataToolChoice,
    contextParallelToolCalls: input.contextParallelToolCalls,
    metadataParallelToolCalls: input.metadataParallelToolCalls,
    contextResponseFormat: input.contextResponseFormat,
    metadataResponseFormat: input.metadataResponseFormat,
    contextServiceTier: input.contextServiceTier,
    metadataServiceTier: input.metadataServiceTier,
    contextTruncation: input.contextTruncation,
    metadataTruncation: input.metadataTruncation,
    contextMetadata: input.contextMetadata,
    metadataMetadata: input.metadataMetadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parsePrepareResponsesRequestEnvelopeOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
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
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAppendLocalImageBlockOnLatestUserInputOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
