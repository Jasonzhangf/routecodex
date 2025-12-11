#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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
  await run('node', ['scripts/mock-provider/run-regressions.mjs']);
}

main().catch((error) => {
  console.error('[golden-cycle] failed:', error.message);
  process.exit(1);
});
