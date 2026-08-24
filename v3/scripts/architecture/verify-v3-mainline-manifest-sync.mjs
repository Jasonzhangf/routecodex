#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(v3Root, '..');
const verifier = resolve(sourceRoot, 'scripts/architecture/verify-architecture-mainline-manifest-sync.mjs');

if (!existsSync(verifier)) {
  console.error(`[verify:v3-mainline-manifest-sync] missing repository-root verifier: ${verifier}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [verifier], {
  cwd: sourceRoot,
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 2);
