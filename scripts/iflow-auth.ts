/**
 * Standalone iFlow OAuth helper built on the new provider auth lifecycle.
 * - Resolves ~/.iflow/oauth_creds.json (or IFLOW_OAUTH_TOKEN_FILE)
 * - Delegates device-code flow to ensureValidOAuthToken (llmswitch-core compliant)
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ensureValidOAuthToken } from '../src/providers/auth/oauth-lifecycle.js';
import type { OAuthAuth } from '../src/providers/core/api/provider-config.js';

async function main() {
  const tokenFile = process.env.IFLOW_OAUTH_TOKEN_FILE || path.join(os.homedir(), '.iflow', 'oauth_creds.json');
  const deviceCodeUrl = process.env.IFLOW_DEVICE_CODE_URL || 'https://iflow.cn/oauth/device/code';
  const tokenUrl = process.env.IFLOW_TOKEN_URL || 'https://iflow.cn/oauth/token';
  const forceReauth = process.env.IFLOW_OAUTH_FORCE_REAUTH === '1';
  const disableBrowser = process.env.IFLOW_OAUTH_NO_BROWSER === '1';

  console.log('[iFlow Auth] Using token file:', tokenFile);
  console.log('[iFlow Auth] OAuth endpoints:');
  console.log('  device:', deviceCodeUrl);
  console.log('  token :', tokenUrl);

  const auth: OAuthAuth = {
    type: 'iflow-oauth',
    tokenFile,
    deviceCodeUrl,
    tokenUrl
  };

  await ensureValidOAuthToken('iflow', auth, {
    forceReauthorize: forceReauth,
    openBrowser: !disableBrowser,
    forceReacquireIfRefreshFails: true
  });

  try {
    const raw = await fs.readFile(tokenFile, 'utf8');
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.expires_at) {
      console.log('[iFlow Auth] Token saved. Expires at:', new Date(parsed.expires_at).toISOString());
    } else {
      console.log('[iFlow Auth] Token saved (no expires_at field present).');
    }
  } catch (error) {
    console.warn('[iFlow Auth] Completed OAuth flow, but failed to read token file:', error);
  }
}

main().catch((err) => {
  console.error('[iFlow Auth] Failed:', err?.message || err);
  process.exit(1);
});
