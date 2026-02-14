/**
 * RouteCodex LLM Switch Bridge
 *
 * Single boundary module for llmswitch-core integration.
 */

import type { ProviderErrorEvent, ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';

// Re-export types from core.
export type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
export type { ProviderUsageEvent } from '@jsonstudio/llms';
export type {
  StaticQuotaConfig,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot
} from '@jsonstudio/llms/dist/quota/index.js';

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
  resetAntigravitySessionSignatureCachesForTests,
  configureAntigravitySessionSignaturePersistence,
  flushAntigravitySessionSignaturePersistenceSync
} from './bridge/antigravity-signature.js';

// Newly factored bridge modules.
export { createCoreQuotaManager } from './bridge/quota-manager.js';
export {
  writeSnapshotViaHooks,
  resumeResponsesConversation,
  rebindResponsesConversationRequestId,
  createResponsesSseToJsonConverter,
  getProviderErrorCenter,
  getProviderSuccessCenter
} from './bridge/runtime-integrations.js';
export {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync,
  extractSessionIdentifiersFromMetadata,
  getStatsCenterSafe,
  getLlmsStatsSnapshot,
  resolveClockConfigSnapshot,
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

// Keep local aliases so external callers can reference the same symbol names.
export type { ProviderErrorEvent as BridgeProviderErrorEvent, ProviderSuccessEvent as BridgeProviderSuccessEvent };
