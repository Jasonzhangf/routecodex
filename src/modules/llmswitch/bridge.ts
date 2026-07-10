/**
 * RouteCodex LLM Switch Bridge
 *
 * Single boundary module for llmswitch-core integration.
 */

import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  ProviderUsageEvent
} from '../../types/llmswitch-local-types.js';

// Re-export types from core.
export type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  ProviderUsageEvent
} from '../../types/llmswitch-local-types.js';

// Core module loading utilities.
export {
  resolveCoreModulePath,
  type AnyRecord
} from './bridge/module-loader.js';

// Existing bridge exports.
export {
  createSnapshotRecorder,
  resetSnapshotRecorderErrorsampleStateForTests,
  type SnapshotRecorder
} from './bridge/snapshot-recorder.js';
export { convertProviderResponse } from './bridge/response-converter.js';
export {
  prepareResponsesHandlerEntryForHttp,
  buildResponsesScopeContinuationExpiredErrorForHttp,
  buildResponsesResumeClientErrorForHttp,
  shouldProjectResponsesResumeClientErrorForHttp,
  captureResponsesRequestContextForHttp,
  captureResponsesInboundToolHistoryErrorsampleForHttp,
  recordResponsesResponseForHttp,
  clearResponsesConversationByRequestIdForHttp,
  clearResponsesConversationOnHandlerFailureForHttp
} from './bridge/responses-request-bridge.js';
export {
  buildClientSseKeepaliveFrameForHttp,
} from './bridge/responses-sse-bridge.js';
export {
  buildResponsesRequestLogContextForHttp,
  normalizeResponsesClientPayloadForHttp,
  normalizeResponsesJsonBodyForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  rebindResponsesConversationRequestIdForHttp,
} from './bridge/responses-response-bridge.js';

// Newly factored bridge modules.
export {
  writeSnapshotViaHooks,
  preloadCriticalBridgeRuntimeModules,
  captureResponsesRequestContextForRequest,
  recordResponsesResponseForRequest,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  materializeLatestResponsesContinuationByScope,
  rebindResponsesConversationRequestId,
  clearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention,
  clearAllResponsesConversationState,
  resetResponsesConversationStateForRestartSimulation,
  clearUnresolvedResponsesConversationRequests,
  buildResponsesJsonFromSseStreamWithNative,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy
} from './bridge/runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  extractSessionIdentifiersFromMetadata
} from './bridge/state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  compileRouteCodexRuntimeManifest,
  collectRouteCodexV2ConfigSourceErrorsSync,
  normalizeRouteCodexV2RuntimeSourceSync,
  resolvePrimaryRouteCodexRoutingPolicyGroupSync,
  extractRouteCodexMaterializedProviderConfigsSync,
  materializeRouteCodexUserConfigFromManifestSync,
  buildRouteCodexProviderProfilesSync,
  buildRouteCodexForwarderProfilesSync,
  parseRouteCodexTomlRecordSync,
  serializeRouteCodexTomlRecordSync,
  updateRouteCodexTomlStringScalarInTableSync,
  decodeRouteCodexUserConfigTextSync,
  decodeRouteCodexProviderConfigTextSync,
  detectRouteCodexUserConfigFormatSync,
  detectRouteCodexProviderConfigFormatSync,
  writeRouteCodexUserConfigFileNativeSync,
  writeRouteCodexProviderConfigFileNativeSync,
  updateRouteCodexUserConfigStringScalarNativeSync,
  loadRouteCodexConfigNativeSync,
  coerceRouteCodexProviderConfigV2Sync,
  planRouteCodexProviderConfigV2FilesSync,
  resolveRouteCodexProviderConfigV2IdentitySync,
  loadRouteCodexProviderConfigsV2FromRootSync,
  planAuthFileResolutionNativeSync,
  resolveAuthFileKeyNativeSync,
  planProviderConfigRootNativeSync,
  planRouteCodexConfigLoaderPathsNativeSync,
  resolveRouteCodexConfigPathNativeSync,
  resolveRccPathNativeSync,
  resolveRccSnapshotsDirNativeSync,
  resolveRccUserDirNativeSync,
  createHubPipelineNative,
  executeHubPipelineNative,
  updateHubPipelineVirtualRouterConfigNative,
  updateHubPipelineEngineDepsNative,
  routeHubPipelineVirtualRouterNative,
  diagnoseHubPipelineVirtualRouterNative,
  getHubPipelineVirtualRouterStatusNative,
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative,
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative,
  disposeHubPipelineNative
} from './bridge/routing-integrations.js';

export {
  mapChatToolsToBridgeJson,
  planResponsesHandlerEntry,
  normalizeAssistantTextToToolCallsJson,
  buildAnthropicResponseFromChatJson,
  injectMcpToolsForChatJson,
  injectMcpToolsForResponsesJson,
  sanitizeProviderOutboundPayload,
  convertResponsesRequestToChatNative,
  evaluateResponsesDirectRouteDecisionNative,
  hasDeclaredApplyPatchToolNative,
  projectSseErrorEventPayloadNative,
  deriveFinishReasonNative,
  isToolCallContinuationResponseNative,
  classifyProviderFailure,
  getNetworkErrorCodes
} from './bridge/native-exports.js';

// Keep local aliases so external callers can reference the same symbol names.
export type { ProviderErrorEvent as BridgeProviderErrorEvent, ProviderSuccessEvent as BridgeProviderSuccessEvent };
