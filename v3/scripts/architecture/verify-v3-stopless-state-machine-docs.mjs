#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/architecture/render-v3-stopless-state-machine-docs.mjs', '--check'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout ?? '');
