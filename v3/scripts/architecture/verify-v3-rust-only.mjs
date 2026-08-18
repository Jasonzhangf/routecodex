#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(v3Root, 'crates');
const ignoredDirs = new Set(['target']);
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (ignoredDirs.has(entry)) {
        continue;
      }
      walk(path);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
      offenders.push(path);
    }
  }
}

try {
  walk(root);
} catch {
  console.error('[verify:v3-rust-only] missing V3 crates/');
  process.exit(1);
}

if (offenders.length) {
  console.error('[verify:v3-rust-only] V3 runtime crates must be Rust-only');
  for (const offender of offenders) console.error('- ' + offender);
  process.exit(1);
}

console.log('[verify:v3-rust-only] ok');
