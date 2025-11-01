#!/usr/bin/env node
// Ensure rcc-llmswitch-core is a real module (no symlink), vendor dist into node_modules
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function isSymlink(p) {
  try { const st = await fsp.lstat(p); return st.isSymbolicLink(); } catch { return false; }
}

async function rimraf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(sp, dp);
    else if (e.isFile()) await fsp.copyFile(sp, dp);
  }
}

async function main() {
  const pkgRoot = process.cwd();
  const nm = path.join(pkgRoot, 'node_modules');
  const coreNm = path.join(nm, 'rcc-llmswitch-core');
  const vendorSrc = path.join(pkgRoot, 'vendor', 'rcc-llmswitch-core');
  const localDist = path.join(vendorSrc, 'dist');

  const needVendor = (await isSymlink(coreNm)) || !(await exists(path.join(coreNm, 'dist', 'api.js')));
  if (!needVendor) return; // already a physical install with dist

  // Remove symlink or stale dir
  await rimraf(coreNm);
  await fsp.mkdir(coreNm, { recursive: true });

  // Prefer local built dist
  if (await exists(localDist)) {
    // write minimal package.json
    const content = await fsp.readFile(path.join(vendorSrc, 'package.json'), 'utf-8').catch(()=>null);
    if (content) await fsp.writeFile(path.join(coreNm, 'package.json'), content, 'utf-8');
    await copyDir(localDist, path.join(coreNm, 'dist'));
    return;
  }

  // Fallback: if no local dist, leave as-is; user must build locally or use global binary
}

main().catch(() => { /* ignore */ });
