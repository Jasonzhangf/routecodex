#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const SOURCE_ROOT = path.join(os.homedir(), '.routecodex', 'golden_samples', 'ci-regression', 'apply_patch');
const TARGET_ROOT = path.join(PROJECT_ROOT, 'samples', 'ci-goldens', '_regressions', 'apply_patch');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listTypeDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function usage() {
  console.log('Usage: node scripts/tools/sync-apply-patch-regressions.mjs [--force]');
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  if (args.includes('--help') || args.includes('-h')) usage();

  if (!fs.existsSync(SOURCE_ROOT)) {
    console.log(`[sync-apply-patch-regressions] skip (source missing: ${SOURCE_ROOT})`);
    return;
  }

  ensureDir(TARGET_ROOT);

  let copied = 0;
  let skipped = 0;
  const types = listTypeDirs(SOURCE_ROOT);
  for (const type of types) {
    const srcDir = path.join(SOURCE_ROOT, type);
    const dstDir = path.join(TARGET_ROOT, type);
    ensureDir(dstDir);
    const files = listJsonFiles(srcDir);
    for (const f of files) {
      const src = path.join(srcDir, f);
      const dst = path.join(dstDir, f);
      if (!force && fs.existsSync(dst)) {
        skipped += 1;
        continue;
      }
      fs.copyFileSync(src, dst);
      copied += 1;
    }
  }

  console.log(
    `[sync-apply-patch-regressions] synced ${copied} file(s) into ${TARGET_ROOT} (${skipped} skipped)`
  );
}

try {
  main();
} catch (error) {
  console.error('[sync-apply-patch-regressions] failed:', error?.message || error);
  process.exit(1);
}

