#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(entry);
    else yield entry;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function main() {
  const SRC = path.resolve(process.cwd(), 'src/modules/pipeline/modules/provider/v2/compatibility');
  const DIST = path.resolve(process.cwd(), 'dist/modules/pipeline/modules/provider/v2/compatibility');
  const copied = [];
  try {
    for await (const file of walk(SRC)) {
      if (file.endsWith('.json') && file.includes(`${path.sep}config${path.sep}`)) {
        const rel = path.relative(SRC, file);
        const dest = path.join(DIST, rel);
        await ensureDir(path.dirname(dest));
        await fs.copyFile(file, dest);
        copied.push(rel);
      }
    }
    // 不再复制 pipeline-config.generated.json 到 dist；统一从 ~/.routecodex/config/generated 读取
    console.log(`[copy-compat-assets] copied ${copied.length} JSON assets`);
  } catch (err) {
    console.error('[copy-compat-assets] failed:', err?.message || String(err));
    process.exit(1);
  }
}

main();
