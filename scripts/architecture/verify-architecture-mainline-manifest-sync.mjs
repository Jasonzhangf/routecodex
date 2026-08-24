#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const verifier = path.join(root, 'v3', 'scripts', 'architecture', 'verify-v3-mainline-manifest-sync.mjs');
const result = spawnSync(process.execPath, [verifier], {
  cwd: root,
  env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
  stdio: 'inherit',
});
process.exit(result.status ?? 2);
