import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseArray,
  parseJson,
  parseRecord,
  parseString,
  parseStringArray,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';
export {
  clampResponsesInputItemIdWithNative,
  normalizeFunctionCallIdWithNative,
  normalizeFunctionCallOutputIdWithNative,
  normalizeResponsesCallIdWithNative
} from './native-shared-conversion-semantics-call-id.js';
export {
  cloneRuntimeMetadataWithNative,
  encodeMetadataPassthroughWithNative,
  ensureProtocolStateWithNative,
  ensureRuntimeMetadataCarrierWithNative,
  extractMetadataPassthroughWithNative,
  getProtocolStateWithNative,
  readRuntimeMetadataWithNative
} from './native-shared-conversion-semantics-metadata.js';
export {
  convertResponsesOutputToInputItemsWithNative,
  enforceChatBudgetWithNative,
  pickResponsesPersistedFieldsWithNative,
  prepareResponsesConversationEntryWithNative,
  resolveBudgetForModelWithNative,
  resumeResponsesConversationPayloadWithNative
} from './native-shared-conversion-semantics-responses.js';
export {
  buildGeminiToolsFromBridgeWithNative,
  injectMcpToolsForChatWithNative,
  injectMcpToolsForResponsesWithNative,
  normalizeArgsBySchemaWithNative,
  normalizeOpenaiChatMessagesWithNative,
  normalizeOpenaiToolCallWithNative,
  prepareGeminiToolsForBridgeWithNative
} from './native-shared-conversion-semantics-tools.js';
export {
  extractApplyPatchCallsFromTextWithNative,
  extractBareExecCommandFromTextWithNative,
  extractExecuteBlocksFromTextWithNative,
  extractExploredListDirectoryCallsFromTextWithNative,
  extractInvokeToolsFromTextWithNative,
  extractJsonToolCallsFromTextWithNative,
  extractParameterXmlToolsFromTextWithNative,
  extractQwenToolCallTokensFromTextWithNative,
  extractSimpleXmlToolsFromTextWithNative,
  extractToolNamespaceXmlBlocksFromTextWithNative,
  extractXMLToolCallsFromTextWithNative,
  mapReasoningContentToResponsesOutputWithNative,
  mergeToolCallsWithNative,
  repairToolCallsWithNative,
  validateToolArgumentsWithNative
} from './native-shared-conversion-semantics-toolcalls.js';
export {
  normalizeChatMessageContentWithNative,
  normalizeContentPartWithNative,
  normalizeMessageContentPartsWithNative,
  normalizeOpenaiMessageWithNative,
  normalizeOpenaiToolWithNative
} from './native-shared-conversion-semantics-openai.js';
export {
  chunkStringWithNative,
  deriveToolCallKeyWithNative,
  flattenByCommaWithNative,
  packShellArgsWithNative,
  repairFindMetaWithNative,
  splitCommandStringWithNative
} from './native-shared-conversion-semantics-shell-utils.js';
export {
  buildProviderProtocolErrorWithNative,
  createStreamingToolExtractorStateWithNative,
  createToolCallIdTransformerWithNative,
  enforceToolCallIdStyleWithNative,
  extractStreamingToolCallsWithNative,
  extractToolCallIdWithNative,
  feedStreamingToolExtractorWithNative,
  isCompactionRequestWithNative,
  isImagePathWithNative,
  normalizeIdValueWithNative,
  normalizeResponsesToolCallIdsWithNative,
  resetStreamingToolExtractorStateWithNative,
  resolveToolCallIdStyleWithNative,
  stripInternalToolingMetadataWithNative,
  transformToolCallIdWithNative
} from './native-shared-conversion-semantics-id-stream.js';
export {
  extractReasoningSegmentsWithNative,
  extractToolCallsFromReasoningTextWithNative,
  normalizeAssistantTextToToolCallsWithNative,
  normalizeReasoningInAnthropicPayloadWithNative,
  normalizeReasoningInChatPayloadWithNative,
  normalizeReasoningInGeminiPayloadWithNative,
  normalizeReasoningInOpenAIPayloadWithNative,
  normalizeReasoningInResponsesPayloadWithNative,
  sanitizeReasoningTaggedTextWithNative
} from './native-shared-conversion-semantics-reasoning.js';
export {
  ensureBridgeInstructionsWithNative,
  parseLenientJsonishWithNative,
  repairArgumentsToStringWithNative
} from './native-shared-conversion-semantics-misc.js';
export {
  bridgeToolToChatDefinitionWithNative,
  chatToolToBridgeDefinitionWithNative,
  collectToolCallsFromResponsesWithNative,
  mapBridgeToolsToChatWithNative,
  mapChatToolsToBridgeWithNative
} from './native-shared-conversion-semantics-tool-definitions.js';

export function resolveFinishReasonWithNative(
  response: Record<string, unknown>,
  toolCalls: Array<Record<string, unknown>>
): string {
  const capability = 'resolveFinishReasonJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response ?? {});
  const toolCallsJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
  if (!responseJson || !toolCallsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson, toolCallsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseString(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildChatResponseFromResponsesWithNative(payload: unknown): Record<string, unknown> | null {
  const capability = 'buildChatResponseFromResponsesJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function hasValidThoughtSignatureWithNative(
  block: unknown,
  options?: Record<string, unknown>
): boolean {
  const capability = 'hasValidThoughtSignatureJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ block: block ?? null, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeThinkingBlockWithNative(block: unknown): Record<string, unknown> {
  const capability = 'sanitizeThinkingBlockJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ block: block ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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

export function filterInvalidThinkingBlocksWithNative(
  messages: unknown,
  options?: Record<string, unknown>
): unknown[] {
  const capability = 'filterInvalidThinkingBlocksJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ messages: Array.isArray(messages) ? messages : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function removeTrailingUnsignedThinkingBlocksWithNative(
  blocks: unknown,
  options?: Record<string, unknown>
): unknown[] {
  const capability = 'removeTrailingUnsignedThinkingBlocksJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ blocks: Array.isArray(blocks) ? blocks : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeToolsWithNative(tools: unknown): Array<Record<string, unknown>> {
  const capability = 'normalizeToolsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(tools ?? null);
  if (!toolsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractOutputSegmentsWithNative(
  source: Record<string, unknown> | undefined,
  itemsKey: string = 'output'
): { textParts: string[]; reasoningParts: string[] } {
  const capability = 'extractOutputSegmentsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ textParts: string[]; reasoningParts: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const sourceJson = safeStringify(source ?? null);
  if (!sourceJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(sourceJson, String(itemsKey || 'output'));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const textParts = Array.isArray(parsed.textParts)
      ? parsed.textParts.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const reasoningParts = Array.isArray(parsed.reasoningParts)
      ? parsed.reasoningParts.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { textParts, reasoningParts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
