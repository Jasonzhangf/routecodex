#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(entry);
    else yield entry;
  }
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function main() {
  const root = process.cwd();
  const srcRoot = path.join(root, 'src', 'modules', 'pipeline', 'modules', 'compatibility');
  const distRoot = path.join(root, 'dist', 'modules', 'pipeline', 'modules', 'compatibility');
  try {
    const files = [];
    for await (const f of walk(srcRoot)) {
      if (f.endsWith('.json') && f.includes(`${path.sep}config${path.sep}`)) files.push(f);
    }
    for (const f of files) {
      const rel = path.relative(srcRoot, f);
      const dst = path.join(distRoot, rel);
      await copyFile(f, dst);
      console.log('[copy-compat-configs] copied', rel);
    }
  } catch (e) {
    console.error('[copy-compat-configs] failed', e?.message || e);
    process.exit(1);
  }
}

main();

