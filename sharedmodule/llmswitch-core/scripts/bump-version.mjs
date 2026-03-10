#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');

const skipEnv = String(
  process.env.LLMS_SKIP_VERSION_BUMP ||
  process.env.ROUTECODEX_SKIP_AUTO_BUMP ||
  process.env.BUILD_SKIP_AUTO_BUMP ||
  ''
)
  .trim()
  .toLowerCase();

const skip = ['1', 'true', 'yes'].includes(skipEnv);

if (skip) {
  console.log('[llms:bump-version] skip requested via env flag');
  process.exit(0);
}

const pkg = readJson(pkgPath) ?? {};
const currentVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.000';
const nextVersion = bumpPatch(currentVersion);

if (nextVersion === currentVersion) {
  console.log(`[llms:bump-version] version unchanged (${currentVersion})`);
  process.exit(0);
}

pkg.version = nextVersion;
writeJson(pkgPath, pkg);
updatePackageLock(lockPath, nextVersion);

console.log(`[llms:bump-version] ${currentVersion} → ${nextVersion}`);

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf-8'));
  } catch {
    return undefined;
  }
}

function writeJson(target, data) {
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function bumpPatch(version) {
  if (typeof version !== 'string' || !version.length) {
    return '0.0.001';
  }
  const parts = version.split('.');
  while (parts.length < 3) {
    parts.push('0');
  }
  const [major, minor, patchRaw] = parts;
  const patch = Number.parseInt(patchRaw, 10);
  const next = Number.isFinite(patch) ? patch + 1 : 1;
  const formatted = String(next).padStart(3, '0');
  return `${major}.${minor}.${formatted}`;
}

function updatePackageLock(target, version) {
  const lock = readJson(target);
  if (!lock) {
    return;
  }
  lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  writeJson(target, lock);
}
