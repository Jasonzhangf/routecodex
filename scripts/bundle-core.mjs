#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

import { exec as _exec } from 'child_process';
import { promisify } from 'util';
const exec = promisify(_exec);

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

async function main() {
  const root = process.cwd();
  const coreRoot = path.join(root, 'sharedmodule', 'llmswitch-core');
  const corePkgPath = path.join(coreRoot, 'package.json');
  const coreDist = path.join(coreRoot, 'dist');

  // Build core (tsc -b) deterministically without relying on workspace script
  try {
    await exec('npx tsc -b', { cwd: coreRoot });
  } catch (e) {
    console.error('[bundle-core] core build failed:', e?.stderr || e?.message || e);
    process.exit(1);
  }

  const nmDest = path.join(root, 'node_modules', '@routecodex', 'llmswitch-core');
  await ensureDir(nmDest);

  // Copy dist
  await copyDir(coreDist, path.join(nmDest, 'dist'));

  // Write minimal package.json reflecting version and exports
  const corePkgRaw = await fs.readFile(corePkgPath, 'utf-8');
  const corePkg = JSON.parse(corePkgRaw);
  const minimal = {
    name: corePkg.name,
    version: corePkg.version,
    type: 'module',
    main: 'dist/index.js',
    module: 'dist/index.js',
    types: 'dist/index.d.ts',
    exports: corePkg.exports || {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' }
    }
  };
  await fs.writeFile(path.join(nmDest, 'package.json'), JSON.stringify(minimal, null, 2));

  // Touch a README to satisfy some packagers (optional)
  await fs.writeFile(path.join(nmDest, 'README.md'), '# @routecodex/llmswitch-core (bundled)\n');

  console.log('[bundle-core] bundled @routecodex/llmswitch-core into node_modules for packing');
}

main().catch((err) => {
  console.error('[bundle-core] failed:', err);
  process.exit(1);
});
