/**
 * OAuth Lifecycle Helpers
 *
 * Re-exports from submodules for backward compatibility.
 */

export {
  isGeminiCliFamily,
  type ExtendedOAuthAuth,
  resolveTokenFilePath,
  resolveCamoufoxAliasForAuth,
  expandHome,
  defaultTokenFile
} from './path-resolver.js';

export {
  keyFor,
  shouldThrottle,
  updateThrottle,
  inFlight,
  interactiveTail,
  lastRunAt
} from './throttle.js';

export {
  extractStatusCode,
  isGoogleAccountVerificationRequiredMessage,
  extractGoogleAccountVerificationUrl
} from './error-detection.js';

export {
  type StoredOAuthToken,
  hasNonEmptyString,
  extractAccessToken,
  extractApiKey,
  hasApiKeyField,
  hasStableQwenApiKey,
  hasAccessToken,
  getExpiresAt,
  resolveProjectId,
  coerceExpiryTimestampSeconds,
  hasNoRefreshFlag,
  evaluateTokenState
} from './token-helpers.js';

export {
  normalizeGeminiCliAccountToken,
  sanitizeToken,
  readTokenFromFile,
  backupTokenFile,
  restoreTokenFileFromBackup,
  discardBackupFile,
  readRawTokenFile
} from './token-io.js';
