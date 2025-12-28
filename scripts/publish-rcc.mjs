#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'pack-mode.mjs');
const pkgPath = path.join(PROJECT_ROOT, 'package.json');

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

try {
  // 1) 使用 release 模式构建 dist（依赖 npm 上的 @jsonstudio/llms）
  run('npm', ['run', 'build:min'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BUILD_MODE: 'release' }
  });

  // 2) 通过 pack-mode 生成 rcc tarball（内部会临时切换 package.json.name/bin 并确保 llms 为 release 包）
  run(process.execPath, [PACK_SCRIPT, '--name', '@jsonstudio/rcc', '--bin', 'rcc'], { cwd: PROJECT_ROOT });

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

  // 4) pack-mode 会在内部检测 dev 链接并调用 ensure-llmswitch-mode 恢复 dev 模式，
  //    因此此处不再额外修改 BUILD_MODE 或重新 link。后续本地如需 dev build，可单独运行 `npm run build:dev`。
} catch (err) {
  console.error('[publish-rcc] failed:', err.message);
  process.exit(1);
}
