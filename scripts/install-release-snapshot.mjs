#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'];
const REQUIRED_COPY_PATHS = [
  'dist',
  'sharedmodule/llmswitch-core/dist',
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

function copyIntoSnapshot(relativePath, targetRoot) {
  const sourcePath = requireExisting(relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: true
    });
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, {
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
  fs.cpSync(dereferencedSource, targetLinkPath, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    force: true
  });
}

function copyOptionalIntoSnapshot(relativePath, targetRoot) {
  const sourcePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  const targetPath = path.join(targetRoot, relativePath);
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
      force: true
    });
    return true;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, {
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

  for (const relativePath of REQUIRED_COPY_PATHS) {
    copyIntoSnapshot(relativePath, stagingDir);
  }
  replaceSnapshotLlmsSymlink(stagingDir);
  for (const relativePath of OPTIONAL_COPY_PATHS) {
    copyOptionalIntoSnapshot(relativePath, stagingDir);
  }

  writeManifest(stagingDir, {
    kind: 'routecodex-release-snapshot',
    version,
    buildMode,
    installedAt,
    sourceRepoRoot: repoRoot
  });

  removeIfExists(releaseDir);
  fs.renameSync(stagingDir, releaseDir);
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
