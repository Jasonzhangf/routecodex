#!/usr/bin/env node
// Gemini CLI OAuth authentication script
// Usage:
//   # 默认使用 ~/.routecodex/auth/gemini-oauth.json（自动创建/更新）
//   node scripts/auth-gemini-cli-token.mjs
//
//   # 或通过环境变量显式指定 token 文件（支持 ~ 展开）：
//   // GEMINI_CLI_TOKEN_FILE="~/.routecodex/auth/gemini-oauth-1-primary.json" node scripts/auth-gemini-cli-token.mjs

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function resolveGeminiTokenPath() {
  const envFile =
    (process.env.GEMINI_CLI_TOKEN_FILE && process.env.GEMINI_CLI_TOKEN_FILE.trim()) ||
    (process.env.ROUTECODEX_GEMINI_TOKEN_FILE && process.env.ROUTECODEX_GEMINI_TOKEN_FILE.trim()) ||
    '';

  if (envFile) {
    const normalized = envFile.startsWith('~')
      ? envFile.replace(/^~\//, `${os.homedir()}/`)
      : envFile;
    return { tokenPath: normalized, duplicates: [] };
  }

  const authDir = path.join(os.homedir(), '.routecodex', 'auth');
  const primaryName = 'gemini-oauth.json';

  let entries = [];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    // directory may not exist yet
    entries = [];
  }

  const matches = entries
    .filter((entry) => entry.endsWith('.json'))
    .filter((entry) => entry === primaryName || entry.startsWith('gemini-oauth-'));

  matches.sort();
  if (matches.length > 0) {
    const canonical = path.join(authDir, matches[0]);
    const duplicates = matches.slice(1).map((name) => path.join(authDir, name));
    return { tokenPath: canonical, duplicates };
  }

  const canonical = path.join(authDir, primaryName);
  return { tokenPath: canonical, duplicates: [] };
}

async function run() {
  const { tokenPath, duplicates } = await resolveGeminiTokenPath();
  console.log(`[gemini-cli-auth] Authenticating token: ${tokenPath}`);

  // ensure token file exists so re-auth can recreate after delete
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  try {
    await fs.access(tokenPath);
  } catch {
    await fs.writeFile(tokenPath, '{}', 'utf-8');
  }

  const { ensureValidOAuthToken } = await import('../dist/providers/auth/oauth-lifecycle.js');

  await ensureValidOAuthToken(
    'gemini-cli',
    {
      type: 'gemini-cli-oauth',
      tokenFile: tokenPath
    },
    {
      forceReauthorize: true,
      openBrowser: true
    }
  );

  // clean up duplicate token files for the same family
  for (const dup of duplicates) {
    if (dup === tokenPath) continue;
    try {
      await fs.unlink(dup);
      console.log(`[gemini-cli-auth] Removed duplicate token file: ${dup}`);
    } catch {
      // ignore
    }
  }

  console.log(`[gemini-cli-auth] Token saved to: ${tokenPath}`);
}

run().catch((err) => {
  console.error('[gemini-cli-auth] Error:', err);
  process.exit(1);
});
