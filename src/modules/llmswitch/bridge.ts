/**
 * RouteCodex LLM Switch Bridge
 *
 * Single boundary module for llmswitch-core integration.
 */

import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  ProviderUsageEvent,
  StaticQuotaConfig,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot
} from '../../types/llmswitch-local-types.js';

// Re-export types from core.
export type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  ProviderUsageEvent,
  StaticQuotaConfig,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot
} from '../../types/llmswitch-local-types.js';

// Core module loading utilities.
export {
  importCoreDist,
  requireCoreDist,
  resolveImplForSubpath,
  resolveCoreModulePath,
  type AnyRecord,
  type LlmsImpl
} from './bridge/module-loader.js';

// Existing bridge exports.
export {
  createSnapshotRecorder,
  resetSnapshotRecorderErrorsampleStateForTests,
  type SnapshotRecorder
} from './bridge/snapshot-recorder.js';
export { convertProviderResponse } from './bridge/response-converter.js';

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
  createResponsesSseToJsonConverter,
  createResponsesJsonToSseConverter,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy,
  setProviderRuntimeQuotaHooks,
  setProviderRuntimeProviderQuotaHooks
} from './bridge/runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  syncStoplessGoalStateFromRequest,
  persistStoplessGoalStateSnapshot,
  readStoplessGoalState,
  extractSessionIdentifiersFromMetadata,
  getStatsCenterSafe,
  getLlmsStatsSnapshot
} from './bridge/state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor,
  getHubPipelineCtorForImpl,
  resolveBaseDir
} from './bridge/routing-integrations.js';

export {
  mapChatToolsToBridgeJson,
  planResponsesHandlerEntry,
  normalizeAssistantTextToToolCallsJson,
  buildAnthropicResponseFromChatJson,
  injectMcpToolsForChatJson,
  injectMcpToolsForResponsesJson,
  sanitizeFollowupText,
  sanitizeProviderOutboundPayload,
  deriveFinishReasonNative,
  isToolCallContinuationResponseNative,
  updateResponsesContractProbeFromSseChunkNative,
  buildResponsesTerminalSseFramesFromProbeNative,
  classifyProviderFailure,
  getNetworkErrorCodes
} from './bridge/native-exports.js';

// Keep local aliases so external callers can reference the same symbol names.
export type { ProviderErrorEvent as BridgeProviderErrorEvent, ProviderSuccessEvent as BridgeProviderSuccessEvent };
