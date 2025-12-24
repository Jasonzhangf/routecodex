#!/usr/bin/env node
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createProviderOAuthStrategy } from '../dist/providers/core/config/provider-oauth-configs.js';

const tokenFile = process.env.IFLOW_TOKEN_FILE || path.join(os.homedir(), '.routecodex', 'auth', 'iflow-oauth-1-primary.json');

async function run() {
  console.log(`[iflow-manual] Manual auth for: ${tokenFile}`);
  
  // ensure token file exists
  const tokenPath = tokenFile.startsWith('~') ? tokenFile.replace(/^~\//, `${os.homedir()}/`) : tokenFile;
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
  console.log(`[iflow-manual] Token saved to: ${tokenPath}`);
}

run().catch(err => { console.error('[iflow-manual] Error:', err); process.exit(1); });
