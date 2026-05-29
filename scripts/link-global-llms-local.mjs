#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const localLlms = path.join(projectRoot, 'sharedmodule', 'llmswitch-core');

function parseArgs(argv) {
  const out = {
    packageNames: [],
    requireTarget: false,
    skipInstallCurrent: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--require-target') {
      out.requireTarget = true;
      continue;
    }
    if (arg === '--skip-install-current') {
      out.skipInstallCurrent = true;
      continue;
    }
    if (arg === '--package' || arg === '-p') {
      const value = String(argv[i + 1] || '').trim();
      i += 1;
      if (value) out.packageNames.push(value);
      continue;
    }
    if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length).trim();
      if (value) out.packageNames.push(value);
      continue;
    }
  }
  return out;
}

function npmRootGlobal() {
  const res = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if ((res.status ?? 1) === 0) {
    const value = String(res.stdout || '').trim();
    if (value) return value;
  }
  const prefix = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8' });
  const fallbackPrefix = (prefix.status ?? 1) === 0 ? String(prefix.stdout || '').trim() : '';
  if (!fallbackPrefix) {
    throw new Error('unable to resolve npm global root');
  }
  return path.join(fallbackPrefix, 'lib', 'node_modules');
}

function ensureLocalLlmsReady() {
  if (!fs.existsSync(localLlms) || !fs.existsSync(path.join(localLlms, 'package.json'))) {
    throw new Error(`local llmswitch-core not found: ${localLlms}`);
  }
  if (!fs.existsSync(path.join(localLlms, 'dist'))) {
    throw new Error(`local llmswitch-core dist missing: ${path.join(localLlms, 'dist')}`);
  }
}

function linkForPackage(globalRoot, packageName) {
  const pkgRoot = path.join(globalRoot, ...packageName.split('/'));
  if (!fs.existsSync(pkgRoot)) {
    return { packageName, changed: false, skipped: true, reason: 'package-not-installed' };
  }
  const scopeDir = path.join(pkgRoot, 'node_modules');
  const linkPath = path.join(scopeDir, 'rcc-llmswitch-core');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(localLlms, linkPath, 'junction');
  const linkedTo = fs.readlinkSync(linkPath);
  return { packageName, changed: true, skipped: false, linkPath, linkedTo };
}

function buildInstallCurrentRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.rcc', 'install', 'current'),
    path.join('/Volumes/extension', '.rcc', 'install', 'current')
  ];
}

function linkForInstallCurrentRoot(installRoot) {
  if (!fs.existsSync(installRoot)) {
    return { installRoot, changed: false, skipped: true, reason: 'install-root-missing' };
  }
  const scopeDir = path.join(installRoot, 'node_modules');
  const linkPath = path.join(scopeDir, 'rcc-llmswitch-core');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(localLlms, linkPath, 'junction');
  const linkedTo = fs.readlinkSync(linkPath);
  return { installRoot, changed: true, skipped: false, linkPath, linkedTo };
}

function main() {
  const args = parseArgs(process.argv);
  const targets = args.packageNames.length > 0 ? args.packageNames : ['routecodex'];
  ensureLocalLlmsReady();
  const globalRoot = npmRootGlobal();
  const results = targets.map((name) => linkForPackage(globalRoot, name));
  const installResults = args.skipInstallCurrent
    ? []
    : buildInstallCurrentRoots().map((root) => linkForInstallCurrentRoot(root));
  const changed = results.filter((it) => it.changed);

  if (args.requireTarget && changed.length <= 0) {
    const detail = results
      .map((it) => `${it.packageName}:${it.skipped ? it.reason : 'unknown'}`)
      .join(', ');
    throw new Error(`no eligible global package found to link rcc-llmswitch-core (${detail})`);
  }

  for (const row of results) {
    if (row.changed) {
      console.log(
        `[link-global-llms-local] linked ${row.packageName} -> ${row.linkPath} => ${row.linkedTo}`
      );
    } else if (row.skipped) {
      console.log(`[link-global-llms-local] skip ${row.packageName} (${row.reason})`);
    }
  }
  for (const row of installResults) {
    if (row.changed) {
      console.log(
        `[link-global-llms-local] linked install current -> ${row.linkPath} => ${row.linkedTo}`
      );
    } else if (row.skipped && row.reason !== 'install-root-missing') {
      console.log(`[link-global-llms-local] skip install current ${row.installRoot} (${row.reason})`);
    }
  }
  if (args.skipInstallCurrent) {
    console.log('[link-global-llms-local] skip install current roots (--skip-install-current)');
  }
}

try {
  main();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[link-global-llms-local] failed: ${reason}`);
  process.exit(1);
}
