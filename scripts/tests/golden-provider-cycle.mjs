#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const HOME = os.homedir();
const USER_SAMPLES_HINT = path.join(HOME, '.routecodex', 'codex-samples');

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function main() {
  await run('node', [
    'scripts/tools/capture-provider-goldens.mjs',
    '--custom-only',
    '--update-golden'
  ]);
  await run('node', ['scripts/mock-provider/run-regressions.mjs'], {
    ROUTECODEX_MOCK_ENTRY_FILTER: 'all'
  });
  if (fs.existsSync(USER_SAMPLES_HINT)) {
    console.log('[golden-cycle] detected ~/.routecodex/codex-samples; run "node scripts/mock-provider/capture-from-configs.mjs" to ingest latest provider recordings for deep regression.');
  } else {
    console.log('[golden-cycle] ~/.routecodex/codex-samples missing; skipping deep regression (optional).');
  }
}

main().catch((error) => {
  console.error('[golden-cycle] failed:', error.message);
  process.exit(1);
});
