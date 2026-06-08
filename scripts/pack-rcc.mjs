#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureRepoPackOutputDir } from './lib/repo-output-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const pkgPath = path.join(PROJECT_ROOT, 'package.json');
const packScriptPath = path.join(PROJECT_ROOT, 'scripts', 'pack-mode.mjs');
const llmsPath = path.join(PROJECT_ROOT, 'node_modules', 'rcc-llmswitch-core');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if ((result.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function isSymlink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

try {
  const hadDevLink = isSymlink(llmsPath);

  run('npm', ['run', 'build:min'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BUILD_MODE: 'release',
      ROUTECODEX_SKIP_AUTO_BUMP: process.env.ROUTECODEX_SKIP_AUTO_BUMP || '1'
    }
  });

  run(process.execPath, [packScriptPath, '--name', 'rcc', '--bin', 'rcc'], {
    cwd: PROJECT_ROOT
  });

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = String(pkg.version || '').trim();
  const tarballName = `rcc-${version}.tgz`;
  const packOutputDir = ensureRepoPackOutputDir(PROJECT_ROOT);
  const tarballPath = path.join(packOutputDir, tarballName);

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }

  console.log(`[pack-rcc] ✅ tarball ready: ${tarballPath}`);

  if (hadDevLink) {
    run('npm', ['run', 'llmswitch:ensure'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, BUILD_MODE: 'dev' }
    });
  }
} catch (error) {
  console.error('[pack-rcc] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
