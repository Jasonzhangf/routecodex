#!/usr/bin/env node
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createProviderOAuthStrategy } from '../dist/providers/core/config/provider-oauth-configs.js';

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
  console.log(`[iflow-manual] Manual auth for: ${tokenPath}`);
  
  // ensure token file exists
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  try { await fs.access(tokenPath); } catch { await fs.writeFile(tokenPath, '{}', 'utf-8'); }
  
  // Use device code flow but let user open the URL manually
  const strategy = createProviderOAuthStrategy('iflow', {
    flowType: 'device_code',
    endpoints: {
      deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
      tokenUrl: 'https://iflow.cn/oauth/token',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: { clientId: '10009311001', scopes: ['openid','profile','email','api'] }
  }, tokenPath);
  
  // Manually trigger device code flow
  const deviceCodeData = await strategy.initiateDeviceCodeFlow();
  console.log('Please open this URL in your browser:');
  console.log(deviceCodeData.verification_uri);
  console.log('User code:', deviceCodeData.user_code);
  console.log('Press Enter when you have authorized...');
  
  await new Promise(resolve => process.stdin.once('data', resolve));
  
  const token = await strategy.pollForToken(deviceCodeData);
  await strategy.saveToken(token);

  // clean up duplicate token files for the same sequence
  for (const dup of duplicates) {
    if (dup === tokenPath) continue;
    try {
      await fs.unlink(dup);
      console.log(`[iflow-manual] Removed duplicate token file: ${dup}`);
    } catch {
      // ignore
    }
  }

  console.log(`[iflow-manual] Token saved to: ${tokenPath}`);
}

run().catch(err => { console.error('[iflow-manual] Error:', err); process.exit(1); });
