/**
 * RouteCodex LLM Switch Bridge
 *
 * Single boundary module for llmswitch-core integration.
 */
import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../types/llmswitch-local-types.js';
export type { ProviderErrorEvent, ProviderSuccessEvent, ProviderUsageEvent } from '../../types/llmswitch-local-types.js';
export { importCoreDist, requireCoreDist, resolveImplForSubpath, resolveCoreModulePath, type AnyRecord, type LlmsImpl } from './bridge/module-loader.js';
export { createSnapshotRecorder, resetSnapshotRecorderErrorsampleStateForTests, type SnapshotRecorder } from './bridge/snapshot-recorder.js';
export { convertProviderResponse } from './bridge/response-converter.js';
export { prepareResponsesHandlerEntryForHttp, buildResponsesScopeContinuationExpiredErrorForHttp, buildResponsesResumeClientErrorForHttp, shouldProjectResponsesResumeClientErrorForHttp, captureResponsesRequestContextForHttp, captureResponsesInboundToolHistoryErrorsampleForHttp, recordResponsesResponseForHttp, clearResponsesConversationByRequestIdForHttp, clearResponsesConversationOnHandlerFailureForHttp } from './bridge/responses-request-bridge.js';
export { buildClientSseKeepaliveFrameForHttp, shouldDropClientSseFrameForHttp, } from './bridge/responses-sse-bridge.js';
export { buildResponsesRequestLogContextForHttp, importResponsesHandlerCoreDist, normalizeResponsesClientPayloadForHttp, prepareResponsesJsonClientDispatchPlanForHttp, requireResponsesHandlerCoreDist, rebindResponsesConversationRequestIdForHttp, } from './bridge/responses-response-bridge.js';
export { writeSnapshotViaHooks, preloadCriticalBridgeRuntimeModules, captureResponsesRequestContextForRequest, recordResponsesResponseForRequest, resumeResponsesConversation, resumeLatestResponsesContinuationByScope, materializeLatestResponsesContinuationByScope, rebindResponsesConversationRequestId, clearResponsesConversationByRequestId, finalizeResponsesConversationRequestRetention, clearAllResponsesConversationState, resetResponsesConversationStateForRestartSimulation, clearUnresolvedResponsesConversationRequests, createResponsesSseToJsonConverter, createResponsesJsonToSseConverter, reportProviderErrorToRouterPolicy, reportProviderSuccessToRouterPolicy } from './bridge/runtime-integrations.js';
export { loadRoutingInstructionStateSync, saveRoutingInstructionStateAsync, saveRoutingInstructionStateSync, extractSessionIdentifiersFromMetadata, getStatsCenterSafe, getLlmsStatsSnapshot } from './bridge/state-integrations.js';
export { bootstrapVirtualRouterConfig, getHubPipelineCtor, getHubPipelineCtorForImpl, resolveBaseDir } from './bridge/routing-integrations.js';
export { mapChatToolsToBridgeJson, planResponsesHandlerEntry, normalizeAssistantTextToToolCallsJson, buildAnthropicResponseFromChatJson, injectMcpToolsForChatJson, injectMcpToolsForResponsesJson, sanitizeProviderOutboundPayload, convertResponsesRequestToChatNative, evaluateResponsesDirectRouteDecisionNative, hasDeclaredApplyPatchToolNative, projectSseErrorEventPayloadNative, deriveFinishReasonNative, isToolCallContinuationResponseNative, classifyProviderFailure, getNetworkErrorCodes } from './bridge/native-exports.js';
export type { ProviderErrorEvent as BridgeProviderErrorEvent, ProviderSuccessEvent as BridgeProviderSuccessEvent };
