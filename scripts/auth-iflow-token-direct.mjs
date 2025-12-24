#!/usr/bin/env node
// iFlow token auth using direct device flow - no browser redirect
// Usage: ILOW_TOKEN_FILE="~/.routecodex/auth/iflow-oauth-1-xxx.json" node scripts/auth-iflow-token-direct.mjs

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const tokenFile = process.env.IFLOW_TOKEN_FILE || path.join(os.homedir(), '.routecodex', 'auth', 'iflow-oauth-1-primary.json');

async function run() {
  console.log(`[iflow-auth-direct] Starting device flow for: ${tokenFile}`);
  
  // ensure token file exists so re-auth can recreate after delete
  const tokenPath = tokenFile.startsWith('~') ? tokenFile.replace(/^~\//, `${os.homedir()}/`) : tokenFile;
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  try {
    await fs.access(tokenPath);
  } catch {
    await fs.writeFile(tokenPath, '{}', 'utf-8');
  }
  
  const { createProviderOAuthStrategy } = await import('../dist/providers/core/config/provider-oauth-configs.js');
  
  // Use device code flow instead of auth code flow
  const strategy = createProviderOAuthStrategy('iflow', {
    flowType: 'device_code',
    endpoints: {
      deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
      tokenUrl: 'https://iflow.cn/oauth/token',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: {
      clientId: process.env.IFLOW_CLIENT_ID || 'iflow-desktop-client',
      scopes: ['openid','profile','email','api']
    }
  }, tokenPath);
  
  console.log('[iflow-auth-direct] Opening browser for device code flow...');
  const token = await strategy.authenticate({ openBrowser: true });
  await strategy.saveToken(token);
  
  console.log(`[iflow-auth-direct] Token saved to: ${tokenPath}`);
}

run().catch(err => {
  console.error('[iflow-auth-direct] Error:', err);
  process.exit(1);
});
