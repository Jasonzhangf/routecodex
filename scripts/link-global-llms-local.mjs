#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const localLlms = path.join(projectRoot, 'sharedmodule', 'llmswitch-core');

function parseArgs(argv) {
  const out = {
    packageNames: [],
    requireTarget: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--require-target') {
      out.requireTarget = true;
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
  const scopeDir = path.join(pkgRoot, 'node_modules', '@jsonstudio');
  const linkPath = path.join(scopeDir, 'llms');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(localLlms, linkPath, 'junction');
  const linkedTo = fs.readlinkSync(linkPath);
  return { packageName, changed: true, skipped: false, linkPath, linkedTo };
}

function main() {
  const args = parseArgs(process.argv);
  const targets = args.packageNames.length > 0 ? args.packageNames : ['@jsonstudio/rcc', 'routecodex'];
  ensureLocalLlmsReady();
  const globalRoot = npmRootGlobal();
  const results = targets.map((name) => linkForPackage(globalRoot, name));
  const changed = results.filter((it) => it.changed);

  if (args.requireTarget && changed.length <= 0) {
    const detail = results
      .map((it) => `${it.packageName}:${it.skipped ? it.reason : 'unknown'}`)
      .join(', ');
    throw new Error(`no eligible global package found to link @jsonstudio/llms (${detail})`);
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
}

try {
  main();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[link-global-llms-local] failed: ${reason}`);
  process.exit(1);
}

