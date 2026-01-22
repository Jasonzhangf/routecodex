#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const pkgPath = path.join(PROJECT_ROOT, 'package.json');
const PACK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'pack-mode.mjs');
const llmsPath = path.join(PROJECT_ROOT, 'node_modules', '@jsonstudio', 'llms');

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

try {
  const hadDevLink = isSymlink(llmsPath);

  // 1) release 模式构建 dist（依赖 npm 上的 @jsonstudio/llms）
  run('npm', ['run', 'build:min'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BUILD_MODE: 'release' }
  });

  // 2) 通过 pack-mode 生成 rcc tarball（内部会临时切换 package.json.name/bin 并确保 llms 为 release 包）
  run(process.execPath, [PACK_SCRIPT, '--name', '@jsonstudio/rcc', '--bin', 'rcc'], { cwd: PROJECT_ROOT });

  const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = updatedPkg.version;
  const tarballName = `jsonstudio-rcc-${version}.tgz`;
  const tarballPath = path.join(PROJECT_ROOT, tarballName);

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }

  console.log(`[pack-rcc] ✅ tarball ready: ${tarballPath}`);

  // 3) pack 结束后恢复 dev 模式（routecodex 约定始终为 dev CLI；rcc 打包时才切 release）。
  if (hadDevLink) {
    run('npm', ['run', 'llmswitch:ensure'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, BUILD_MODE: 'dev' }
    });
  }
} catch (err) {
  console.error('[pack-rcc] failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

