#!/usr/bin/env node
// Antigravity OAuth authentication script
// Usage:
//   # 默认使用 ~/.routecodex/auth/antigravity-oauth.json（自动创建/更新）
//   node scripts/auth-antigravity-token.mjs
//
//   # 或通过环境变量显式指定 token 文件（支持 ~ 展开）：
//   // ANTIGRAVITY_TOKEN_FILE="~/.routecodex/auth/antigravity-oauth-alt.json" node scripts/auth-antigravity-token.mjs

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function resolveAntigravityTokenPath() {
  const envFile =
    (process.env.ANTIGRAVITY_TOKEN_FILE && process.env.ANTIGRAVITY_TOKEN_FILE.trim()) ||
    (process.env.ROUTECODEX_ANTIGRAVITY_TOKEN_FILE && process.env.ROUTECODEX_ANTIGRAVITY_TOKEN_FILE.trim()) ||
    '';

  if (envFile) {
    const normalized = envFile.startsWith('~')
      ? envFile.replace(/^~(?=$|\/)/, os.homedir())
      : envFile;
    return path.resolve(normalized);
  }

  const home = os.homedir();
  return path.join(home, '.routecodex', 'auth', 'antigravity-oauth.json');
}

async function run() {
  const tokenPath = await resolveAntigravityTokenPath();
  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(tokenPath);
  } catch {
    await fs.writeFile(tokenPath, '{}', 'utf-8');
  }

  const { ensureValidOAuthToken } = await import('../dist/providers/auth/oauth-lifecycle.js');

  console.log(`[antigravity-auth] Authenticating token: ${tokenPath}`);

  await ensureValidOAuthToken(
    'antigravity',
    {
      type: 'antigravity-oauth',
      tokenFile: tokenPath
    },
    {
      forceReauthorize: true,
      openBrowser: true
    }
  );

  console.log(`[antigravity-auth] Token saved to: ${tokenPath}`);
}

run().catch((err) => {
  console.error('[antigravity-auth] Error:', err);
  process.exit(1);
});

