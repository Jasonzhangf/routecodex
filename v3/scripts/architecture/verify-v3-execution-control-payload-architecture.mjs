#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync(process.execPath, ['scripts/architecture/render-v3-execution-control-payload-architecture.mjs', '--check'], {
  cwd: v3Root,
  encoding: 'utf8',
});

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
