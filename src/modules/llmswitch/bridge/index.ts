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
  buildClientSseKeepaliveFrameForHttp,
} from './responses-sse-bridge.js';
export {
  buildResponsesRequestLogContextForHttp,
  importResponsesHandlerCoreDist,
  normalizeResponsesClientPayloadForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  requireResponsesHandlerCoreDist,
  rebindResponsesConversationRequestIdForHttp,
} from './responses-response-bridge.js';
export {
  writeSnapshotViaHooks,
  preloadCriticalBridgeRuntimeModules,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  rebindResponsesConversationRequestId,
  clearUnresolvedResponsesConversationRequests,
  buildResponsesJsonFromSseStreamWithNative,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy
} from './runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  extractSessionIdentifiersFromMetadata
} from './state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  createHubPipelineNative,
  executeHubPipelineNative,
  updateHubPipelineVirtualRouterConfigNative,
  updateHubPipelineEngineDepsNative,
  routeHubPipelineVirtualRouterNative,
  diagnoseHubPipelineVirtualRouterNative,
  getHubPipelineVirtualRouterStatusNative,
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative,
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative,
  disposeHubPipelineNative,
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
  projectSseErrorEventPayloadNative,
  isToolCallContinuationResponseNative,
  validatePipelineNodeContractBoundaryNative,
  getNetworkErrorCodes
} from './native-exports.js';
