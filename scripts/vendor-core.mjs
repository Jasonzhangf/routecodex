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
  const sharedDist = path.join(root, 'sharedmodule', 'llmswitch-core', 'dist');
  const vendorDir = path.join(root, 'vendor', 'rcc-llmswitch-core');

  if (!await exists(sharedDist)) {
    console.error('[vendor-core] ERROR: 未找到 sharedmodule/llmswitch-core/dist');
    console.error('[vendor-core] 请先进入 sharedmodule/llmswitch-core 并运行 `npm run build`。');
    process.exit(2);
  }

  if (await exists(vendorDir)) {
    await rmrf(vendorDir);
    console.log('[vendor-core] removed legacy vendor/rcc-llmswitch-core directory');
  }

  console.log('[vendor-core] sharedmodule/llmswitch-core/dist 将被直接引用，已停止生成 vendor 副本。');
}

main().catch((err) => {
  console.error('[vendor-core] failed', err?.message || err);
  process.exit(1);
});
