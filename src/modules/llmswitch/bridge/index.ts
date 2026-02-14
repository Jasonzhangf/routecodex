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
