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

function runNodeEval(source, options = {}) {
  return run(process.execPath, ['--input-type=module', '-e', source], {
    cwd: PROJECT_ROOT,
    ...options,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertNoRepoPath(value, label) {
  if (String(value).includes(PROJECT_ROOT)) {
    fail(`${label} leaks repo path ${PROJECT_ROOT}`);
  }
}

function verifyTarballShape(tarballPath, packageName) {
  if (!fs.existsSync(tarballPath)) {
    fail(`tarball missing: ${tarballPath}`);
  }

  const list = run('tar', ['-tzf', tarballPath]);
  if (/^package\/node_modules\/(?:esbuild|@esbuild\/)/m.test(list.stdout)) {
    fail(`${packageName} release tarball unexpectedly contains esbuild packages`);
  }

  const inspectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${packageName}-release-inspect.`));
  try {
    run('tar', ['-xzf', tarballPath, '-C', inspectDir]);
    const packedPackagePath = path.join(inspectDir, 'package', 'package.json');
    const packedPackage = readJson(packedPackagePath);
    const deps = Object.keys(packedPackage.dependencies || {}).sort();
    const bundled = (packedPackage.bundleDependencies || packedPackage.bundledDependencies || []).slice().sort();
    const missing = deps.filter((dependency) => !bundled.includes(dependency));
    if (packedPackage.name !== packageName) fail(`${packageName} packed name mismatch: ${packedPackage.name}`);
    if (packedPackage.dependencies?.esbuild) fail(`${packageName} packed package has esbuild production dependency`);
    if (bundled.includes('esbuild')) fail(`${packageName} packed package bundles esbuild`);
    if (missing.length > 0) fail(`${packageName} packed dependencies missing from bundle: ${missing.join(', ')}`);
    assertNoRepoPath(JSON.stringify(packedPackage), `${packageName} packed package.json`);
  } finally {
    fs.rmSync(inspectDir, { recursive: true, force: true });
  }
}

function verifyNormalInstall(tarballPath, packageName, binName, version) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), `${packageName}-normal-install.`));
  try {
    run('npm', ['install', '-g', tarballPath, '--prefix', prefix, '--no-audit', '--no-fund'], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    });

    const binPath = path.join(prefix, 'bin', binName);
    const versionResult = run(binPath, ['--version'], { cwd: PROJECT_ROOT });
    if (!versionResult.stdout.includes(version)) {
      fail(`${packageName} installed ${binName} version mismatch: ${JSON.stringify(versionResult.stdout.trim())}`);
    }

    const packageDir = path.join(prefix, 'lib', 'node_modules', packageName);
    const installedPackage = readJson(path.join(packageDir, 'package.json'));
    const llmsDir = path.join(packageDir, 'node_modules', 'rcc-llmswitch-core');
    const builtinLlmsDir = path.join(packageDir, 'sharedmodule', 'llmswitch-core');
    const checks = {
      packageDirIsSymlink: fs.lstatSync(packageDir).isSymbolicLink(),
      packageJsonHasRepoPath: JSON.stringify(installedPackage).includes(PROJECT_ROOT),
      llmsExists: fs.existsSync(llmsDir),
      llmsIsSymlink: fs.existsSync(llmsDir) ? fs.lstatSync(llmsDir).isSymbolicLink() : true,
      llmsDistExists: fs.existsSync(path.join(llmsDir, 'dist')),
      builtinLlmsDistExists: fs.existsSync(path.join(builtinLlmsDir, 'dist')),
      esbuildExists: fs.existsSync(path.join(packageDir, 'node_modules', 'esbuild')),
    };
    if (checks.packageDirIsSymlink) fail(`${packageName} installed package is a symlink`);
    if (checks.packageJsonHasRepoPath) fail(`${packageName} installed package.json leaks repo path`);
    if (!checks.llmsExists) fail(`${packageName} installed rcc-llmswitch-core is missing`);
    if (checks.llmsIsSymlink) fail(`${packageName} installed rcc-llmswitch-core must not be a symlink`);
    if (!checks.llmsDistExists) fail(`${packageName} installed rcc-llmswitch-core/dist is missing`);
    if (!checks.builtinLlmsDistExists) fail(`${packageName} installed sharedmodule/llmswitch-core/dist is missing`);
    if (checks.esbuildExists) fail(`${packageName} installed release should not contain esbuild`);

    runNodeEval(`
      const packageDir = ${JSON.stringify(packageDir)};
      const candidates = [
        'dist/modules/llmswitch/bridge/native-exports.js',
        'dist/modules/llmswitch/bridge/routing-integrations.js',
        'sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js',
        'sharedmodule/llmswitch-core/dist/servertool/metadata-center-carrier.js',
        'node_modules/rcc-llmswitch-core/dist/native/servertool-wrapper.js',
        'node_modules/rcc-llmswitch-core/dist/servertool/metadata-center-carrier.js',
      ];
      for (const relativePath of candidates) {
        await import(new URL(relativePath, 'file://' + packageDir.replace(/\\/$/, '') + '/').href);
      }
      const activeServertoolWrapperExports = [
        'buildServertoolDispatchPlanInputWithNative',
        'buildServertoolOutcomePlanInputWithNative',
        'formatStopMessageCompareContextWithNative',
        'planServertoolOutcomeWithNative',
        'readServertoolPrimaryAutoHookIdsWithNative',
        'runServertoolResponseStageWithNative',
        'planEngineSelectionStartWithNative',
        'resolveEngineSelectionAfterRunWithNative',
        'resolveServertoolExecutionLoopInitialDecisionWithNative',
        'resolveServertoolExecutionLoopResultDecisionWithNative',
      ];
      for (const relativePath of [
        'sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js',
        'node_modules/rcc-llmswitch-core/dist/native/servertool-wrapper.js',
      ]) {
        const mod = await import(new URL(relativePath, 'file://' + packageDir.replace(/\\/$/, '') + '/').href);
        for (const exportName of activeServertoolWrapperExports) {
          if (typeof mod[exportName] !== 'function') {
            throw new Error(relativePath + ' missing function export ' + exportName);
          }
        }
      }
      const routing = await import(new URL('dist/modules/llmswitch/bridge/routing-integrations.js', 'file://' + packageDir.replace(/\\/$/, '') + '/').href);
      for (const exportName of ['createHubPipelineNative', 'executeHubPipelineNative', 'disposeHubPipelineNative']) {
        if (typeof routing[exportName] !== 'function') {
          throw new Error('dist/modules/llmswitch/bridge/routing-integrations.js missing function export ' + exportName);
        }
      }
    `, { cwd: packageDir });

    return {
      packageName,
      tarball: tarballPath,
      prefix,
      version,
      dependencies: Object.keys(installedPackage.dependencies || {}).length,
      bundledDependencies: (installedPackage.bundleDependencies || installedPackage.bundledDependencies || []).length,
      llmsDistExists: checks.llmsDistExists,
      builtinLlmsDistExists: checks.builtinLlmsDistExists,
      esbuildExists: checks.esbuildExists,
    };
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

const rootPackage = readJson(path.join(PROJECT_ROOT, 'package.json'));
const version = String(rootPackage.version || '').trim();
if (!version) fail('package.json version is empty');

if (rootPackage.dependencies?.esbuild) {
  fail('esbuild must stay out of production dependencies; it is a build-time dependency');
}

const releasePackages = [
  { packageName: 'routecodex', binName: 'routecodex', tarballPath: path.join(PROJECT_ROOT, 'artifacts', 'pack', `routecodex-${version}.tgz`) },
  { packageName: 'rcc', binName: 'rcc', tarballPath: path.join(PROJECT_ROOT, 'artifacts', 'pack', `rcc-${version}.tgz`) },
];

const reports = [];
for (const releasePackage of releasePackages) {
  verifyTarballShape(releasePackage.tarballPath, releasePackage.packageName);
  reports.push(verifyNormalInstall(
    releasePackage.tarballPath,
    releasePackage.packageName,
    releasePackage.binName,
    version
  ));
}

console.log(JSON.stringify({ version, packages: reports }, null, 2));
