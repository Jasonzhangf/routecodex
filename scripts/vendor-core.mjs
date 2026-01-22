#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  const root = process.cwd();
  const rawMode = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase();
  const mode = rawMode === 'dev' ? 'dev' : 'release';
  const sharedDist = path.join(root, 'sharedmodule', 'llmswitch-core', 'dist');
  const legacyVendorDir = path.join(root, 'vendor', 'rcc-llmswitch-core');
  const scopedVendorDir = path.join(root, 'vendor', '@jsonstudio', 'llms');

  // In release mode we rely on npm-installed `@jsonstudio/llms`, so the local sharedmodule dist
  // is optional and must not block CI (where sharedmodule often doesn't exist).
  // In dev mode, `node_modules/@jsonstudio/llms` is typically symlinked to sharedmodule/llmswitch-core,
  // so we keep a hard requirement for the dist output.
  if (mode === 'dev' && !await exists(sharedDist)) {
    console.error('[vendor-core] ERROR: 未找到 sharedmodule/llmswitch-core/dist (BUILD_MODE=dev)');
    console.error('[vendor-core] 请先进入 sharedmodule/llmswitch-core 并运行 `npm run build`。');
    process.exit(2);
  }

  if (await exists(legacyVendorDir)) {
    await rmrf(legacyVendorDir);
    console.log('[vendor-core] removed legacy vendor/rcc-llmswitch-core directory');
  }
  if (await exists(scopedVendorDir)) {
    await rmrf(scopedVendorDir);
    console.log('[vendor-core] removed legacy vendor/@jsonstudio/llms directory');
  }

  if (mode === 'dev') {
    console.log('[vendor-core] sharedmodule/llmswitch-core/dist 将被直接引用，已停止生成 vendor 副本。');
  } else {
    console.log('[vendor-core] BUILD_MODE=release: using npm-installed @jsonstudio/llms (no vendor copy).');
  }
}

main().catch((err) => {
  console.error('[vendor-core] failed', err?.message || err);
  process.exit(1);
});
