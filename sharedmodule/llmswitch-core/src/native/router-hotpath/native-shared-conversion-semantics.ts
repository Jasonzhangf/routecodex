import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseRecord,
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
  materializeResponsesContinuationPayloadWithNative,
  pickResponsesPersistedFieldsWithNative,
  planResponsesHandlerEntryWithNative,
  prepareResponsesConversationEntryWithNative,
  resolveBudgetForModelWithNative,
  restoreResponsesContinuationPayloadWithNative,
  resumeResponsesConversationPayloadWithNative,
  stripResponsesStoredContextInputMediaWithNative
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
  expandResponsesMessageItemWithNative,
  normalizeChatMessageContentWithNative,
  normalizeMessageContentPartsWithNative,
  normalizeOpenaiMessageWithNative,
  normalizeOpenaiToolWithNative,
  normalizeResponsesOutputItemsWithNative,
  normalizeResponsesMessageItemWithNative
} from './native-shared-conversion-semantics-openai.js';
export {
  deriveToolCallKeyWithNative,
  repairFindMetaWithNative,
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
  resetStreamingToolExtractorStateWithNative,
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
  captureReqInboundResponsesContextSnapshotWithNative
} from './native-hub-pipeline-req-inbound-semantics-tools.js';
export {
  flattenChatToolsForFunctionCallingWithNative,
  mapBridgeToolsToChatWithNative,
  mapChatToolsToBridgeWithNative
} from './native-shared-conversion-semantics-tool-definitions.js';

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

export function buildChatResponseFromResponsesFullWithNative(input: { payload: string }): string {
  const capability = 'buildChatResponseFromResponsesFullJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
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
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
