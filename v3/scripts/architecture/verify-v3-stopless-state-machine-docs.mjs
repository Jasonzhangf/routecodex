#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const renderScript = existsSync('scripts/architecture/render-v3-stopless-state-machine-docs.mjs')
  ? 'scripts/architecture/render-v3-stopless-state-machine-docs.mjs'
  : 'v3/scripts/architecture/render-v3-stopless-state-machine-docs.mjs';

const result = spawnSync(process.execPath, [renderScript, '--check'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout ?? '');
