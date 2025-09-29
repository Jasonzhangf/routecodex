/**
 * Standalone iFlow OAuth Device Flow helper.
 * - Loads existing token from ~/.iflow/oauth_creds.json (or IFLOW_OAUTH_TOKEN_FILE)
 * - If missing/expired, starts device flow, prints link + code, and opens browser.
 */

import { createIFlowOAuth } from '../src/modules/pipeline/modules/provider/iflow-oauth.js';
import os from 'os';
import path from 'path';

async function main() {
  const tokenFile = process.env.IFLOW_OAUTH_TOKEN_FILE || path.join(os.homedir(), '.iflow', 'oauth_creds.json');
  const deviceCodeUrl = process.env.IFLOW_DEVICE_CODE_URL || 'https://iflow.cn/oauth/device/code';
  const tokenUrl = process.env.IFLOW_TOKEN_URL || 'https://iflow.cn/oauth/token';

  console.log('[iFlow Auth] Using token file:', tokenFile);
  console.log('[iFlow Auth] OAuth endpoints:');
  console.log('  device:', deviceCodeUrl);
  console.log('  token :', tokenUrl);

  const oauth = createIFlowOAuth({ tokenFile, deviceCodeUrl, tokenUrl });

  const token = await oauth.loadToken();
  if (token && !token.isExpired()) {
    const remaining = Math.max(0, token.expires_at - Date.now());
    console.log(`[iFlow Auth] Existing token is valid for ${Math.round(remaining / 1000)}s. No action needed.`);
    return;
  }

  console.log('[iFlow Auth] No valid token. Starting device flow...');
  const storage = await oauth.completeOAuthFlow(true);
  console.log('[iFlow Auth] New token acquired. Expires at:', new Date(storage.expires_at).toISOString());
}

main().catch((err) => {
  console.error('[iFlow Auth] Failed:', err?.message || err);
  process.exit(1);
});

