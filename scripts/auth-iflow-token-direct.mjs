#!/usr/bin/env node
// iFlow token auth using direct device flow - no browser redirect
// Usage: ILOW_TOKEN_FILE="~/.routecodex/auth/iflow-oauth-1-xxx.json" node scripts/auth-iflow-token-direct.mjs

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function resolveIflowTokenPath() {
  const envFile = process.env.IFLOW_TOKEN_FILE;
  if (envFile && envFile.trim()) {
    const normalized = envFile.startsWith('~') ? envFile.replace(/^~\//, `${os.homedir()}/`) : envFile;
    return { tokenPath: normalized, duplicates: [] };
  }

  const authDir = path.join(os.homedir(), '.routecodex', 'auth');
  const seq = 1;
  const prefix = `iflow-oauth-${seq}`;
  let entries = [];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    // directory may not exist yet
  }
  const matches = entries
    .filter((entry) => entry.endsWith('.json'))
    .filter((entry) => entry === `${prefix}.json` || entry.startsWith(`${prefix}-`));
  matches.sort();
  if (matches.length > 0) {
    const canonical = path.join(authDir, matches[0]);
    const duplicates = matches.slice(1).map((name) => path.join(authDir, name));
    return { tokenPath: canonical, duplicates };
  }
  const canonical = path.join(authDir, `${prefix}-primary.json`);
  return { tokenPath: canonical, duplicates: [] };
}

async function run() {
  const { tokenPath, duplicates } = await resolveIflowTokenPath();
  console.log(`[iflow-auth-direct] Starting device flow for: ${tokenPath}`);
  
  // ensure token file exists so re-auth can recreate after delete
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

  // clean up duplicate token files for the same sequence
  for (const dup of duplicates) {
    if (dup === tokenPath) continue;
    try {
      await fs.unlink(dup);
      console.log(`[iflow-auth-direct] Removed duplicate token file: ${dup}`);
    } catch {
      // ignore
    }
  }
  
  console.log(`[iflow-auth-direct] Token saved to: ${tokenPath}`);
}

run().catch(err => {
  console.error('[iflow-auth-direct] Error:', err);
  process.exit(1);
});
