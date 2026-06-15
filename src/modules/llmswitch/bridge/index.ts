/**
 * Bridge Submodule Index
 *
 * Re-exports from bridge submodules.
 */

export {
  parsePrefixList,
  matchesPrefix,
  isEngineEnabled,
  getEnginePrefixes,
  resolveImplForSubpath,
  resolveCoreModulePath,
  importCoreDist,
  requireCoreDist,
  type AnyRecord,
  type LlmsImpl
} from './module-loader.js';

export { createSnapshotRecorder, resetSnapshotRecorderErrorsampleStateForTests, type SnapshotRecorder } from './snapshot-recorder.js';
export { convertProviderResponse } from './response-converter.js';
export {
  finalizeResponsesHandlerPayloadForHttp,
  prepareResponsesHandlerEntryForHttp,
  buildResponsesScopeContinuationExpiredErrorForHttp,
  buildResponsesResumeClientErrorForHttp,
  shouldProjectResponsesResumeClientErrorForHttp,
  captureResponsesRequestContextForHttp,
  captureResponsesInboundToolHistoryErrorsampleForHttp,
  recordResponsesResponseForHttp,
  clearResponsesConversationByRequestIdForHttp,
  clearResponsesConversationOnHandlerFailureForHttp
} from './responses-request-bridge.js';
export {
  assertDirectPassthroughResponsesSseFrameForHttp,
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp,
  buildClientSseKeepaliveFrameForHttp,
  buildResponsesMissingSseBridgeErrorPayloadForHttp,
  buildResponsesPayloadFromChatForHttp,
  buildResponsesRequestLogContextForHttp,
  buildResponsesSseErrorPayloadForHttp,
  buildResponsesStreamIncompleteErrorPayloadForHttp,
  buildResponsesStructuredSseErrorPayloadForHttp,
  buildResponsesTerminalSseFramesFromProbeForHttp,
  createResponsesJsonToSseConverterForHttp,
  hasResponsesSsePayloadForHttp,
  importResponsesHandlerCoreDist,
  inspectResponsesContinuationProbeForHttp,
  inspectResponsesTerminalStateFromSseChunkForHttp,
  isDirectPassthroughTransportKeepaliveFrameForHttp,
  isToolCallContinuationResponseForHttp,
  normalizeChatUsagePayloadForHttp,
  normalizeResponsesJsonBodyForHttp,
  normalizeResponsesSseFrameForClientForHttp,
  planResponsesContinuationCloseActionForHttp,
  planResponsesStreamEndRepairForHttp,
  prepareResponsesJsonBodyForSseBridgeForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  prepareResponsesJsonSseDispatchPlanForHttp,
  projectResponsesClientPayloadForClientForHttp,
  projectResponsesSseFrameForClientForHttp,
  requireResponsesHandlerCoreDist,
  resolveResponsesClientPayloadFinishReasonForHttp,
  resolveResponsesRequestContextForHttp,
  resolveResponsesProviderProtocolHintFromSseFrameForHttp,
  resolveResponsesTerminalProbeFinishReasonForHttp,
  shouldDispatchResponsesSseToClientForHttp,
  shouldPersistResponsesContinuationOnProbeUpdateForHttp,
  shouldPersistResponsesConversationStateForHttp,
  shouldRepairResponsesContinuationTerminalForHttp,
  shouldRequireResponsesTerminalEventForHttp,
  shouldDropClientSseFrameForHttp,
  summarizeResponsesSseFrameForLogForHttp,
  updateResponsesContractProbeFromSseChunkForHttp,
} from './responses-sse-bridge.js';
export {
  resolveResponsesConversationClearReasonForHttp,
  shouldClearResponsesConversationOnClientCloseForHttp,
  shouldClearResponsesConversationOnFailureForHttp,
  captureResponsesRequestContextForHttpProjection,
  rebindResponsesConversationRequestIdForHttp,
  clearResponsesConversationByRequestIdForHttpProjection,
  recordResponsesResponseForHttpProjection,
  finalizeResponsesConversationRequestRetentionForHttp,
} from './responses-response-bridge.js';
export {
  writeSnapshotViaHooks,
  preloadCriticalBridgeRuntimeModules,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  rebindResponsesConversationRequestId,
  clearUnresolvedResponsesConversationRequests,
  createResponsesSseToJsonConverter,
  createResponsesJsonToSseConverter,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy
} from './runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  extractSessionIdentifiersFromMetadata,
  getStatsCenterSafe,
  getLlmsStatsSnapshot
} from './state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor,
  getHubPipelineCtorForImpl,
  resolveBaseDir
} from './routing-integrations.js';

export {
  mapChatToolsToBridgeJson,
  buildAnthropicResponseFromChatJson,
  injectMcpToolsForChatJson,
  injectMcpToolsForResponsesJson
} from './native-exports.js';

export {
  classifyProviderFailure,
  describeHubPipelineContractsNative,
  describeMetaCarrierContractsNative,
  describePipelineContractNative,
  describeVirtualRouterContractsNative,
  deriveFinishReasonNative,
  isToolCallContinuationResponseNative,
  validatePipelineNodeContractBoundaryNative,
  updateResponsesContractProbeFromSseChunkNative,
  buildResponsesTerminalSseFramesFromProbeNative,
  getNetworkErrorCodes
} from './native-exports.js';
