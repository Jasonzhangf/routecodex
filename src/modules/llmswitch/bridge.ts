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
export {
  warmupAntigravitySessionSignatureModule,
  extractAntigravityGeminiSessionId,
  cacheAntigravitySessionSignature,
  getAntigravityLatestSignatureSessionIdForAlias,
  lookupAntigravitySessionSignatureEntry,
  invalidateAntigravitySessionSignature,
  clearAntigravitySessionAliasPins,
  resetAntigravitySessionSignatureCachesForTests,
  configureAntigravitySessionSignaturePersistence,
  flushAntigravitySessionSignaturePersistenceSync
} from './bridge/antigravity-signature.js';

// Newly factored bridge modules.
export { createCoreQuotaManager } from './bridge/quota-manager.js';
export {
  writeSnapshotViaHooks,
  preloadCriticalBridgeRuntimeModules,
  resumeResponsesConversation,
  resumeLatestResponsesContinuationByScope,
  rebindResponsesConversationRequestId,
  createResponsesSseToJsonConverter,
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy,
  setProviderRuntimeQuotaHooks,
  setProviderRuntimeProviderQuotaHooks
} from './bridge/runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  syncReasoningStopModeFromRequest,
  extractSessionIdentifiersFromMetadata,
  getStatsCenterSafe,
  getLlmsStatsSnapshot,
  resolveClockConfigSnapshot,
  startClockDaemonIfNeededSnapshot,
  setClockRuntimeHooksSnapshot,
  buildHeartbeatInjectTextSnapshot,
  resolveHeartbeatConfigSnapshot,
  startHeartbeatDaemonIfNeededSnapshot,
  setHeartbeatRuntimeHooksSnapshot,
  loadHeartbeatStateSnapshot,
  listHeartbeatStatesSnapshot,
  listHeartbeatHistorySnapshot,
  appendHeartbeatHistoryEventSnapshot,
  setHeartbeatEnabledSnapshot,
  runHeartbeatDaemonTickSnapshot,
  reserveClockDueTasks,
  commitClockDueReservation,
  listClockSessionIdsSnapshot,
  listClockTasksSnapshot,
  scheduleClockTasksSnapshot,
  updateClockTaskSnapshot,
  cancelClockTaskSnapshot,
  clearClockTasksSnapshot
} from './bridge/state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor,
  getHubPipelineCtorForImpl,
  resolveBaseDir
} from './bridge/routing-integrations.js';

export {
  mapChatToolsToBridgeJson,
  normalizeAssistantTextToToolCallsJson,
  buildAnthropicResponseFromChatJson,
  injectMcpToolsForChatJson,
  injectMcpToolsForResponsesJson,
  sanitizeFollowupText,
  classifyProviderFailure,
  getNetworkErrorCodes
} from './bridge/native-exports.js';

// Keep local aliases so external callers can reference the same symbol names.
export type { ProviderErrorEvent as BridgeProviderErrorEvent, ProviderSuccessEvent as BridgeProviderSuccessEvent };
