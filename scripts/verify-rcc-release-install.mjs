#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`[verify-rcc-release-install] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    ...options,
  });
  if ((result.status ?? 0) !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(' ')} failed`);
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertNoRepoPath(value, label) {
  if (String(value).includes(PROJECT_ROOT)) {
    fail(`${label} leaks repo path ${PROJECT_ROOT}`);
  }
}

const rootPackage = readJson(path.join(PROJECT_ROOT, 'package.json'));
const version = String(rootPackage.version || '').trim();
if (!version) fail('package.json version is empty');

if (rootPackage.dependencies?.esbuild) {
  fail('esbuild must stay out of production dependencies; it is a build-time dependency');
}

const tarballPath = path.join(PROJECT_ROOT, 'artifacts', 'pack', `rcc-${version}.tgz`);
if (!fs.existsSync(tarballPath)) {
  fail(`tarball missing: ${tarballPath}`);
}

const list = run('tar', ['-tzf', tarballPath]);
if (/^package\/node_modules\/(?:esbuild|@esbuild\/)/m.test(list.stdout)) {
  fail('release tarball unexpectedly contains esbuild packages');
}

const inspectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-release-inspect.'));
try {
  run('tar', ['-xzf', tarballPath, '-C', inspectDir]);
  const packedPackagePath = path.join(inspectDir, 'package', 'package.json');
  const packedPackage = readJson(packedPackagePath);
  const deps = Object.keys(packedPackage.dependencies || {}).sort();
  const bundled = (packedPackage.bundleDependencies || packedPackage.bundledDependencies || []).slice().sort();
  const missing = deps.filter((dependency) => !bundled.includes(dependency));
  if (packedPackage.name !== 'rcc') fail(`packed name mismatch: ${packedPackage.name}`);
  if (packedPackage.dependencies?.esbuild) fail('packed package has esbuild production dependency');
  if (bundled.includes('esbuild')) fail('packed package bundles esbuild');
  if (missing.length > 0) fail(`packed dependencies missing from bundle: ${missing.join(', ')}`);
  assertNoRepoPath(JSON.stringify(packedPackage), 'packed package.json');
} finally {
  fs.rmSync(inspectDir, { recursive: true, force: true });
}

const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-normal-install.'));
try {
  run('npm', ['install', '-g', tarballPath, '--prefix', prefix, '--no-audit', '--no-fund'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
  });

  const binPath = path.join(prefix, 'bin', 'rcc');
  const versionResult = run(binPath, ['--version'], { cwd: PROJECT_ROOT });
  if (!versionResult.stdout.includes(version)) {
    fail(`installed rcc version mismatch: ${JSON.stringify(versionResult.stdout.trim())}`);
  }

  const packageDir = path.join(prefix, 'lib', 'node_modules', 'rcc');
  const installedPackage = readJson(path.join(packageDir, 'package.json'));
  const llmsDir = path.join(packageDir, 'node_modules', 'rcc-llmswitch-core');
  const checks = {
    packageDirIsSymlink: fs.lstatSync(packageDir).isSymbolicLink(),
    packageJsonHasRepoPath: JSON.stringify(installedPackage).includes(PROJECT_ROOT),
    llmsExists: fs.existsSync(llmsDir),
    llmsIsSymlink: fs.existsSync(llmsDir) ? fs.lstatSync(llmsDir).isSymbolicLink() : true,
    llmsDistExists: fs.existsSync(path.join(llmsDir, 'dist')),
    esbuildExists: fs.existsSync(path.join(packageDir, 'node_modules', 'esbuild')),
  };
  if (checks.packageDirIsSymlink) fail('installed package is a symlink');
  if (checks.packageJsonHasRepoPath) fail('installed package.json leaks repo path');
  if (!checks.llmsExists) fail('installed rcc-llmswitch-core is missing');
  if (checks.llmsIsSymlink) fail('installed rcc-llmswitch-core must not be a symlink');
  if (!checks.llmsDistExists) fail('installed rcc-llmswitch-core/dist is missing');
  if (checks.esbuildExists) fail('installed release should not contain esbuild');

  console.log(JSON.stringify({
    tarball: tarballPath,
    prefix,
    version,
    dependencies: Object.keys(installedPackage.dependencies || {}).length,
    bundledDependencies: (installedPackage.bundleDependencies || installedPackage.bundledDependencies || []).length,
    llmsDistExists: checks.llmsDistExists,
    esbuildExists: checks.esbuildExists,
  }, null, 2));
} finally {
  fs.rmSync(prefix, { recursive: true, force: true });
}
