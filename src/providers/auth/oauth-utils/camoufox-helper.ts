/**
 * Camoufox Helper for OAuth
 *
 * Re-exports resolveCamoufoxAliasForAuth from canonical path-resolver.
 * openGoogleAccountVerificationInCamoufox remains the unique implementation here.
 */

import path from 'path';
import { openAuthInCamoufox } from '../../core/config/camoufox-launcher.js';
import { resolveCamoufoxAliasForAuth, type ExtendedOAuthAuth } from '../oauth-lifecycle/path-resolver.js';

export { resolveCamoufoxAliasForAuth };

/**
 * Open Google account verification URL in Camoufox browser
 */
export async function openGoogleAccountVerificationInCamoufox(args: {
  providerType: string;
  auth: ExtendedOAuthAuth;
  url: string;
}): Promise<void> {
  const providerType = args.providerType;
  const url = args.url;
  if (!url) {
    return;
  }
  const alias = resolveCamoufoxAliasForAuth(providerType, args.auth);

  const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
  const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
  const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;

  process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
  delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
  process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '1';
  try {
    const ok = await openAuthInCamoufox({ url, provider: providerType, alias });
    if (ok) {
      console.warn(`[OAuth] Google account verification opened in Camoufox (provider=${providerType} alias=${alias}).`);
    }
  } catch (error) {
    // best-effort; log but never block requests
    console.warn('[OAuth] Failed to open Camoufox for Google verification', { providerType, alias, error });
  } finally {
    if (prevBrowser === undefined) {
      delete process.env.ROUTECODEX_OAUTH_BROWSER;
    } else {
      process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
    }
    if (prevAutoMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
    }
    if (prevDevMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
    }
    if (prevOpenOnly === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
    }
  }
}
