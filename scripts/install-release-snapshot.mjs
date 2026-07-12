#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'];
const REQUIRED_COPY_PATHS = [
  'dist',
  'sharedmodule/llmswitch-core/dist',
  'samples/mock-provider',
  'config',
  'configsamples',
  'package.json',
  'node_modules'
];
const OPTIONAL_COPY_PATHS = ['docs', 'README.md', 'LICENSE'];

function resolveHomeDir() {
  const home = String(process.env.HOME || '').trim() || os.homedir();
  return path.resolve(home);
}

function resolveRccHome() {
  for (const key of USER_DIR_ENV_KEYS) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) {
      continue;
    }
    return path.resolve(raw.startsWith('~/') ? path.join(resolveHomeDir(), raw.slice(2)) : raw);
  }
  return path.join(resolveHomeDir(), '.rcc');
}

function resolveSourceRepoRoot() {
  const raw = String(process.env.ROUTECODEX_RELEASE_SOURCE_ROOT || '').trim();
  if (!raw) {
    return repoRoot;
  }
  return path.resolve(raw.startsWith('~/') ? path.join(resolveHomeDir(), raw.slice(2)) : raw);
}

function requireExisting(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`required build artifact missing: ${absolutePath}`);
  }
  return absolutePath;
}

function sanitizeReleaseId(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function isInterruptedSystemCall(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'EINTR');
}

function retryDelayMs(attempt) {
  return 50 * attempt;
}

function waitBeforeRetry(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copyPathSync(sourcePath, targetPath, options) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.cpSync(sourcePath, targetPath, options);
      return;
    } catch (error) {
      if (!isInterruptedSystemCall(error) || attempt >= maxAttempts) {
        throw error;
      }
      console.warn(
        `[release-snapshot] copy interrupted by EINTR, retrying (${attempt}/${maxAttempts - 1}): ${targetPath}`
      );
      removeIfExists(targetPath);
      waitBeforeRetry(retryDelayMs(attempt));
    }
  }
}

function copyIntoSnapshot(relativePath, targetRoot) {
  const sourcePath = requireExisting(relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    copyPathSync(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: true
    });
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  copyPathSync(sourcePath, targetPath, {
    dereference: true,
    preserveTimestamps: true,
    force: true
  });
}

function replaceSnapshotLlmsSymlink(snapshotRoot) {
  const sourceLinkPath = requireExisting(path.join('node_modules', 'rcc-llmswitch-core'));
  const targetLinkPath = path.join(snapshotRoot, 'node_modules', 'rcc-llmswitch-core');
  const sourceStat = fs.lstatSync(sourceLinkPath);
  const targetStat = fs.existsSync(targetLinkPath) ? fs.lstatSync(targetLinkPath) : null;
  if (!sourceStat.isSymbolicLink() && (!targetStat || !targetStat.isSymbolicLink())) {
    return;
  }
  const dereferencedSource = fs.realpathSync(sourceLinkPath);
  removeIfExists(targetLinkPath);
  for (const relativePath of [
    'package.json',
    'dist',
    'types',
    'config',
    'README.md',
    'LICENSE'
  ]) {
    const sourcePath = path.join(dereferencedSource, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const targetPath = path.join(targetLinkPath, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    copyPathSync(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: true
    });
  }
  if (!fs.existsSync(path.join(targetLinkPath, 'package.json'))) {
    throw new Error(`rcc-llmswitch-core snapshot package.json missing after copy: ${targetLinkPath}`);
  }
  if (!fs.existsSync(path.join(targetLinkPath, 'dist', 'native', 'router_hotpath_napi.node'))) {
    throw new Error(`rcc-llmswitch-core snapshot native binding missing after copy: ${targetLinkPath}`);
  }
}

function copyOptionalIntoSnapshot(relativePath, targetRoot) {
  const sourcePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  const targetPath = path.join(targetRoot, relativePath);
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    copyPathSync(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: true
    });
    return true;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  copyPathSync(sourcePath, targetPath, {
    dereference: true,
    preserveTimestamps: true,
    force: true
  });
  return true;
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function writeManifest(snapshotRoot, manifest) {
  const manifestPath = path.join(snapshotRoot, 'install-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function dependencyPackageJsonPath(rootDir, packageName) {
  return path.join(rootDir, 'node_modules', ...packageName.split('/'), 'package.json');
}

function verifySnapshotProductionDependencies(snapshotRoot) {
  const snapshotPackage = readJsonFile(path.join(snapshotRoot, 'package.json'));
  const dependencies = Object.keys(snapshotPackage.dependencies || {}).sort();
  const missing = dependencies.filter((dependencyName) => {
    return !fs.existsSync(dependencyPackageJsonPath(snapshotRoot, dependencyName));
  });
  if (missing.length > 0) {
    throw new Error(`snapshot production dependencies missing: ${missing.join(', ')}`);
  }
}

function verifySnapshotRuntimeImports(snapshotRoot) {
  const importCandidates = [
    'dist/error-handling/route-error-hub.js',
    'dist/error-handling/quiet-error-handling-center.js',
    'dist/utils/error-handler-registry.js'
  ].filter((relativePath) => fs.existsSync(path.join(snapshotRoot, relativePath)));

  if (importCandidates.length === 0) {
    return;
  }

  const source = `
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const snapshotRoot = process.argv[1];
    const importCandidates = JSON.parse(process.argv[2]);
    for (const relativePath of importCandidates) {
      await import(pathToFileURL(path.join(snapshotRoot, relativePath)).href);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, snapshotRoot, JSON.stringify(importCandidates)], {
    cwd: snapshotRoot,
    encoding: 'utf8'
  });
  if ((result.status ?? 0) !== 0) {
    const detail = `${String(result.stdout || '').trim()}\n${String(result.stderr || '').trim()}`.trim();
    throw new Error(`snapshot runtime import verification failed: ${detail || 'unknown error'}`);
  }
}

function readPackageVersion() {
  const pkgPath = requireExisting('package.json');
  const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '0.0.0';
}

function readBuildMode() {
  const buildInfoPath = requireExisting(path.join('dist', 'build-info.js'));
  const content = fs.readFileSync(buildInfoPath, 'utf8');
  const match = content.match(/mode:\s*'([^']+)'/);
  return match?.[1] || 'unknown';
}

function updateCurrentSymlink(installRoot, releaseDir) {
  const currentLink = path.join(installRoot, 'current');
  const tempLink = path.join(installRoot, `.current-${process.pid}-${Date.now()}`);
  fs.mkdirSync(installRoot, { recursive: true });
  const relativeTarget = path.relative(installRoot, releaseDir) || '.';
  fs.symlinkSync(relativeTarget, tempLink, 'dir');
  try {
    removeIfExists(currentLink);
    fs.renameSync(tempLink, currentLink);
  } catch (error) {
    removeIfExists(tempLink);
    throw error;
  }
}

function pruneOldReleases(releasesDir, currentReleaseId, keepCount = 3) {
  if (!fs.existsSync(releasesDir)) {
    return [];
  }
  const entries = fs.readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const fullPath = path.join(releasesDir, entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [];
  let retained = 0;
  for (const entry of entries) {
    if (entry.name === currentReleaseId) {
      retained += 1;
      continue;
    }
    if (retained < keepCount - 1) {
      retained += 1;
      continue;
    }
    removeIfExists(entry.fullPath);
    removed.push(entry.name);
  }
  return removed;
}

function main() {
  requireExisting(path.join('dist', 'cli.js'));
  requireExisting(path.join('dist', 'index.js'));
  requireExisting(path.join('node_modules', 'rcc-llmswitch-core'));

  const version = readPackageVersion();
  const buildMode = readBuildMode();
  const installedAt = new Date().toISOString();
  const releaseId = sanitizeReleaseId(`routecodex-${version}-${installedAt.replace(/[:]/g, '').replace(/\..+$/, 'Z')}`);
  const rccHome = resolveRccHome();
  const installRoot = path.join(rccHome, 'install');
  const releasesDir = path.join(installRoot, 'releases');
  const releaseDir = path.join(releasesDir, releaseId);
  const stagingDir = path.join(releasesDir, `.staging-${releaseId}-${process.pid}`);

  removeIfExists(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const relativePath of REQUIRED_COPY_PATHS) {
      copyIntoSnapshot(relativePath, stagingDir);
    }
    replaceSnapshotLlmsSymlink(stagingDir);
    for (const relativePath of OPTIONAL_COPY_PATHS) {
      copyOptionalIntoSnapshot(relativePath, stagingDir);
    }

    writeManifest(stagingDir, {
      kind: 'routecodex-release-snapshot',
      releaseId,
      version,
      buildMode,
      installedAt,
      sourceRepoRoot: resolveSourceRepoRoot(),
      buildRepoRoot: repoRoot,
      installRoot,
      distCli: path.join(releaseDir, 'dist', 'cli.js')
    });

    verifySnapshotProductionDependencies(stagingDir);
    verifySnapshotRuntimeImports(stagingDir);

    removeIfExists(releaseDir);
    fs.renameSync(stagingDir, releaseDir);
  } catch (error) {
    removeIfExists(stagingDir);
    throw error;
  }
  updateCurrentSymlink(installRoot, releaseDir);
  const removedReleases = pruneOldReleases(releasesDir, releaseId, 3);

  const currentPath = path.join(installRoot, 'current');
  console.log(`[release-snapshot] installed ${releaseId}`);
  console.log(`[release-snapshot] current -> ${currentPath}`);
  console.log(`[release-snapshot] runtime root ${releaseDir}`);
  if (removedReleases.length > 0) {
    console.log(`[release-snapshot] pruned ${removedReleases.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[release-snapshot] failed: ${reason}`);
  process.exit(1);
}
