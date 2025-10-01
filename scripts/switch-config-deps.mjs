#!/usr/bin/env node
// Toggle RouteCodex config modules between local workspace and published versions

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const pkgPath = path.join(ROOT, 'package.json');
const mode = process.argv[2] || 'local'; // 'local' | 'published'

const TARGETS = [
  'routecodex-config-engine',
  'routecodex-config-compat',
];

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

function switchDeps() {
  const pkg = readJSON(pkgPath);
  const deps = pkg.dependencies || {};
  let changed = 0;

  for (const name of TARGETS) {
    if (!(name in deps)) continue;
    if (mode === 'local') {
      // Prefer local workspace resolution explicitly
      // Using workspace protocol ensures linking to workspace packages
      deps[name] = 'workspace:^0.1.0';
    } else if (mode === 'published') {
      // Use registry version (falls back to published package)
      deps[name] = '^0.1.0';
    }
    changed++;
  }

  if (!changed) {
    console.log('[switch-config-deps] No target dependencies found to update.');
    return;
  }

  pkg.dependencies = deps;
  writeJSON(pkgPath, pkg);
  console.log(`[switch-config-deps] Updated ${changed} dependency entries to '${mode}'.`);
}

try {
  switchDeps();
  console.log(`[switch-config-deps] Done. Next: npm i`);
} catch (e) {
  console.error('[switch-config-deps] Failed:', e?.message || e);
  process.exit(1);
}

