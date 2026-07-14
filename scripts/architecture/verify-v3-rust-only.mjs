#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'v3';
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
      offenders.push(path);
    }
  }
}

try {
  walk(root);
} catch {
  console.error('[verify:v3-rust-only] missing v3/');
  process.exit(1);
}

if (offenders.length) {
  console.error('[verify:v3-rust-only] V3 MVP source must be Rust-only');
  for (const offender of offenders) console.error('- ' + offender);
  process.exit(1);
}

console.log('[verify:v3-rust-only] ok');
