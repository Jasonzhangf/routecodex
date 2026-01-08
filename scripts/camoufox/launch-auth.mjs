#!/usr/bin/env node
// Camoufox OAuth launcher for RouteCodex
// Usage: node launch-auth.mjs --profile <profileId> --url <oauth_or_portal_url>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = { profile: 'default', url: '' };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const key = list[i];
    const val = list[i + 1] ?? '';
    if (key === '--profile' && val) {
      args.profile = String(val);
      i += 1;
    } else if (key === '--url' && val) {
      args.url = String(val);
      i += 1;
    }
  }
  return args;
}

function stripAnsi(input) {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

async function getCamoufoxCacheRoot() {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'camoufox', 'path'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const cleaned = stripAnsi(out).trim();
      const line = cleaned.split(/\r?\n/).filter((l) => l.trim()).pop() || '';
      resolve(line || null);
    });
  });
}

async function ensureProfileDir(profileId) {
  const root = path.join(os.homedir(), '.routecodex', 'camoufox-profiles');
  const dir = path.join(root, profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const { profile, url } = parseArgs(process.argv);
  if (!url) {
    console.error('[camoufox-launch-auth] Missing --url');
    process.exit(1);
  }

  const profileId = profile || 'default';
  const profileDir = await ensureProfileDir(profileId);

  const cacheRoot = await getCamoufoxCacheRoot();
  if (!cacheRoot) {
    console.error('[camoufox-launch-auth] Failed to resolve Camoufox cache root via "python3 -m camoufox path"');
    process.exit(1);
  }

  const appPath = path.join(cacheRoot, 'Camoufox.app');
  const macBinary = path.join(appPath, 'Contents', 'MacOS', 'camoufox');

  const isMac = process.platform === 'darwin';

  try {
    // Prefer直接启动 Camoufox 二进制，这样 -profile 和 URL 参数由 Camoufox 自己处理，
    // 不再依赖 macOS 的 `open` 对 URL 的特殊行为。
    const bin = isMac && fs.existsSync(macBinary) ? macBinary : 'camoufox';
    const child = spawn(bin, ['-profile', profileDir, url], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.error('[camoufox-launch-auth] Failed to launch Camoufox:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[camoufox-launch-auth] Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
