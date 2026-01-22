#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') { out.name = argv[++i]; continue; }
    if (a === '--bin') { out.bin = argv[++i]; continue; }
    if (a === '--tag') { out.tag = argv[++i]; continue; }
  }
  return out;
}

const projectRoot = process.cwd();
const args = parseArgs(process.argv);
if (!args.name || !args.bin) {
  console.error('Usage: node scripts/pack-mode.mjs --name <packageName> --bin <binName>');
  process.exit(1);
}

const pkgPath = path.join(projectRoot, 'package.json');
const backupPath = pkgPath + '.bak.pack';
const ensureScriptPath = path.join(projectRoot, 'scripts', 'ensure-llmswitch-mode.mjs');
const llmsPath = path.join(projectRoot, 'node_modules', '@jsonstudio', 'llms');

function runEnsureMode(mode) {
  const env = { ...process.env, BUILD_MODE: mode };
  const res = spawnSync(process.execPath, [ensureScriptPath], { stdio: 'inherit', env });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`ensure-llmswitch-mode failed for ${mode}`);
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const isDevPkg = args.name === 'routecodex';
const isRcc = args.name === 'rcc' || args.name === '@jsonstudio/rcc';
const isRccx = args.name === '@jsonstudio/rccx';

let hadDevLink = false;
if (!isRccx) {
  hadDevLink = isSymlink(llmsPath);
  runEnsureMode('release');
}

const original = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));

try {
  const mutated = { ...original };
  mutated.name = args.name;
  mutated.bin = { [args.bin]: 'dist/cli.js' };
  // Ensure description mentions mode
  const suffix = (isRcc || isRccx) ? ' (release)' : ' (dev)';
  mutated.description = String(original.description || 'RouteCodex')
    .replace(/\s*\((dev|release)\)$/, '')
    .concat(suffix);
  // Prefer real dependencies over bundled to avoid missing build artifacts (e.g., ajv/dist)

  if (isDevPkg || isRcc) {
    mutated.bundledDependencies = [];
    mutated.bundleDependencies = [];
    const llmsVersion = original.dependencies?.['@jsonstudio/llms'] || '^0.6.230';
    const deps = {
      ...(original.dependencies || {})
    };
    // Avoid recursive self-dependency when packing @jsonstudio/rcc.
    if (isRcc && deps['@jsonstudio/rcc']) {
      delete deps['@jsonstudio/rcc'];
    }
    mutated.dependencies = {
      ...deps,
      ajv: original.dependencies?.ajv || '^8.17.1',
      zod: original.dependencies?.zod || '^3.23.8',
      '@jsonstudio/llms': llmsVersion
    };
  } else if (isRccx) {
    // rccx: wasm-backed llms 核心，通过 npm alias 将 @jsonstudio/llms 指向 wasm 引擎包。
    mutated.bundledDependencies = [];
    mutated.bundleDependencies = [];

    const deps = { ...(original.dependencies || {}) };
    // 移除原有 TS 版 llms 直连依赖
    if (deps['@jsonstudio/llms']) {
      delete deps['@jsonstudio/llms'];
    }
    // 推断 wasm 引擎版本，若未声明则使用本地 llms-engine 缺省版本
    const engineVersion = deps['@jsonstudio/llms-engine'] || '^0.3.0';
    deps['@jsonstudio/llms-engine'] = engineVersion;
    // 通过 npm alias 保持 import 形状不变
    deps['@jsonstudio/llms'] = `npm:@jsonstudio/llms-engine@${engineVersion}`;
    deps.ajv = deps.ajv || '^8.17.1';
    deps.zod = deps.zod || '^3.23.8';

    mutated.dependencies = deps;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(mutated, null, 2));

  // pack
  const r = spawnSync('npm', ['pack'], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error('npm pack failed');
  }
} finally {
  // restore
  fs.writeFileSync(pkgPath, fs.readFileSync(backupPath, 'utf-8'));
  fs.unlinkSync(backupPath);
  if (hadDevLink) {
    try {
      runEnsureMode('dev');
    } catch (err) {
      console.warn('[pack-mode] failed to restore dev llms link:', err);
    }
  }
}
