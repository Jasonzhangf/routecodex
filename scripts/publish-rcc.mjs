#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'pack-mode.mjs');
const pkgPath = path.join(PROJECT_ROOT, 'package.json');
const llmsPath = path.join(PROJECT_ROOT, 'node_modules', '@jsonstudio', 'llms');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--llms-tgz') { out.llmsTgz = argv[++i]; continue; }
    if (a === '--llms-version') { out.llmsVersion = argv[++i]; continue; }
  }
  return out;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

try {
  const args = parseArgs(process.argv);
  const llmsTgz = String(args.llmsTgz || process.env.RCC_LLMS_TGZ || '').trim();
  const llmsVersion = String(args.llmsVersion || process.env.RCC_LLMS_VERSION || '').trim();

  const hadDevLink = (() => {
    try {
      return fs.lstatSync(llmsPath).isSymbolicLink();
    } catch {
      return false;
    }
  })();

  if (llmsTgz) {
    if (!exists(llmsTgz)) {
      throw new Error(`--llms-tgz not found: ${llmsTgz}`);
    }
    if (hadDevLink) {
      run(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'link-llmswitch.mjs'), 'unlink'], { cwd: PROJECT_ROOT });
    }
    run('npm', ['install', '--no-audit', '--no-fund', '--no-save', llmsTgz], { cwd: PROJECT_ROOT });
  }

  // 1) 使用 release 模式构建 dist（依赖 npm 上的 @jsonstudio/llms）
  run('npm', ['run', 'build:min'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BUILD_MODE: 'release', ...(llmsVersion ? { RCC_LLMS_VERSION: llmsVersion } : {}) }
  });

  // 2) 通过 pack-mode 生成 rcc tarball（内部会临时切换 package.json.name/bin 并确保 llms 为 release 包）
  run(
    process.execPath,
    [PACK_SCRIPT, '--name', '@jsonstudio/rcc', '--bin', 'rcc'],
    { cwd: PROJECT_ROOT, env: { ...process.env, ...(llmsVersion ? { RCC_LLMS_VERSION: llmsVersion } : {}) } }
  );

  // 构建过程中版本号可能被 bump（gen-build-info 会 auto-bump），因此需要在 pack 之后重新读取版本号
  const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = updatedPkg.version;
  const tarballName = `jsonstudio-rcc-${version}.tgz`;
  const tarballPath = path.join(PROJECT_ROOT, tarballName);

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }

  // 3) 发布 npm 包
  run('npm', ['publish', tarballName], { cwd: PROJECT_ROOT });

  // 4) 发布结束后恢复 dev 模式（routecodex 约定始终为 dev CLI；rcc 发布时才切 release）。
  if (hadDevLink) {
    run('npm', ['run', 'llmswitch:ensure'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, BUILD_MODE: 'dev' }
    });
  }
} catch (err) {
  console.error('[publish-rcc] failed:', err.message);
  process.exit(1);
}
