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
  importCoreDist,
  requireCoreDist,
  type AnyRecord,
  type LlmsImpl
} from './module-loader.js';

export { createSnapshotRecorder, type SnapshotRecorder } from './snapshot-recorder.js';
export { convertProviderResponse } from './response-converter.js';
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
} from './antigravity-signature.js';
export { createCoreQuotaManager } from './quota-manager.js';
export {
  writeSnapshotViaHooks,
  resumeResponsesConversation,
  rebindResponsesConversationRequestId,
  createResponsesSseToJsonConverter,
  getProviderErrorCenter,
  getProviderSuccessCenter
} from './runtime-integrations.js';
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
} from './state-integrations.js';
export {
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor,
  getHubPipelineCtorForImpl,
  resolveBaseDir
} from './routing-integrations.js';
