#!/usr/bin/env node
// iFlow token authentication script for specific token file
// Usage: ILOW_TOKEN_FILE="~/.routecodex/auth/iflow-oauth-1-xxx.json" node scripts/auth-iflow-token.mjs

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const tokenFile = process.env.IFLOW_TOKEN_FILE || path.join(os.homedir(), '.routecodex', 'auth', 'iflow-oauth-1-primary.json');

async function run() {
  console.log(`[iflow-auth] Authenticating token: ${tokenFile}`);

  // ensure token file exists so re-auth can recreate after delete
  const tokenPath = tokenFile.startsWith('~') ? tokenFile.replace(/^~\//, `${os.homedir()}/`) : tokenFile;
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  try {
    await fs.access(tokenPath);
  } catch {
    await fs.writeFile(tokenPath, '{}', 'utf-8');
  }

  const { ensureValidOAuthToken } = await import('../dist/providers/auth/oauth-lifecycle.js');
  
  await ensureValidOAuthToken('iflow', {
    type: 'iflow-oauth',
    tokenFile
  }, {
    forceReauthorize: true,
    openBrowser: true
  });
  
  console.log(`[iflow-auth] Token saved to: ${tokenFile}`);
}

run().catch(err => {
  console.error('[iflow-auth] Error:', err);
  process.exit(1);
});
