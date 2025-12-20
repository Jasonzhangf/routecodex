#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'pack-mode.mjs');
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
const version = packageJson.version;
const tarballName = `jsonstudio-rcc-${version}.tgz`;
const tarballPath = path.join(PROJECT_ROOT, tarballName);

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

try {
  run(process.execPath, [PACK_SCRIPT, '--name', '@jsonstudio/rcc', '--bin', 'rcc'], { cwd: PROJECT_ROOT });
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }
  run('npm', ['publish', tarballName], { cwd: PROJECT_ROOT });
} catch (err) {
  console.error('[publish-rcc] failed:', err.message);
  process.exit(1);
}
