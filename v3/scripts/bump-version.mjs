#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const v3Root = path.resolve(scriptDir, '..');
const packagePath = path.join(v3Root, 'package.json');
const lockPath = path.join(v3Root, 'package-lock.json');

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`V3 package version is not semver: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const previousVersion = String(packageJson.version || '').trim();
const nextVersion = nextPatchVersion(previousVersion);
packageJson.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lockJson.version = nextVersion;
if (lockJson.packages?.['']) lockJson.packages[''].version = nextVersion;
fs.writeFileSync(lockPath, `${JSON.stringify(lockJson, null, 2)}\n`);
process.stdout.write(`[v3 bump-version] ${previousVersion} -> ${nextVersion}\n`);
