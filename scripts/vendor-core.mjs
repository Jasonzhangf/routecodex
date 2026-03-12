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

  const hasLocalSharedDist = await exists(sharedDist);

  // 当本地 sharedmodule/llmswitch-core 存在时，dev/release 都以它为唯一真源。
  // 仅在 release 且本地 sharedmodule 缺失时，才允许退回 npm-installed @jsonstudio/llms。
  if (!hasLocalSharedDist && mode === 'dev') {
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

  if (hasLocalSharedDist) {
    const banner = mode === 'dev'
      ? '[vendor-core] BUILD_MODE=dev: direct-use local sharedmodule/llmswitch-core/dist (no vendor copy).'
      : '[vendor-core] BUILD_MODE=release with local sharedmodule/llmswitch-core/dist: direct-use local core (no vendor copy).';
    console.log(banner);
  } else if (mode === 'dev') {
    console.log('[vendor-core] sharedmodule/llmswitch-core/dist 将被直接引用，已停止生成 vendor 副本。');
  } else {
    console.log('[vendor-core] BUILD_MODE=release without local sharedmodule: using npm-installed @jsonstudio/llms (no vendor copy).');
  }
}

main().catch((err) => {
  console.error('[vendor-core] failed', err?.message || err);
  process.exit(1);
});
