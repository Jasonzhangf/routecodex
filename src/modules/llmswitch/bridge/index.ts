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
  writeSnapshotViaHooks,
  preloadCriticalBridgeRuntimeModules,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  rebindResponsesConversationRequestId,
  clearUnresolvedResponsesConversationRequests,
  createResponsesSseToJsonConverter,
  createResponsesJsonToSseConverter,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy,
  setProviderRuntimeQuotaHooks,
  setProviderRuntimeProviderQuotaHooks
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
  deriveFinishReasonNative,
  getNetworkErrorCodes
} from './native-exports.js';
