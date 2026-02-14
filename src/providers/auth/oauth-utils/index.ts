/**
 * OAuth Utils Index
 *
 * Barrel exports for OAuth utility modules.
 */

export {
  extractStatusCode,
  isGoogleAccountVerificationRequiredMessage,
  extractGoogleAccountVerificationUrl
} from './error-extraction.js';

export {
  resolveCamoufoxAliasForAuth,
  openGoogleAccountVerificationInCamoufox
} from './camoufox-helper.js';