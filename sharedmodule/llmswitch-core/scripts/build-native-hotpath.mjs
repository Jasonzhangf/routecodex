#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rustRoot = path.join(projectRoot, 'rust-core');
const cargoManifest = path.join(rustRoot, 'Cargo.toml');
const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
const cargoTargetRoot = resolveCargoTargetRoot();
const targetRelease = path.join(cargoTargetRoot, 'release');
const distNativeDir = path.join(projectRoot, 'dist', 'native');
const distBinDir = path.join(projectRoot, 'dist', 'bin');
const packagedNodeTarget = path.join(distNativeDir, 'router_hotpath_napi.node');
const requiredNativeExportsSource = path.join(
  projectRoot,
  'src',
  'native',
  'router-hotpath',
  'native-router-hotpath-required-exports.ts'
);
const servertoolBinaryName = process.platform === 'win32' ? 'routecodex-servertool.exe' : 'routecodex-servertool';
const releaseServertoolBinary = path.join(targetRelease, servertoolBinaryName);
const packagedServertoolBinary = path.join(distBinDir, servertoolBinaryName);
const releaseArtifacts = [
  path.join(targetRelease, 'router_hotpath_napi.node'),
  releaseServertoolBinary,
  path.join(targetRelease, 'deps', 'librouter_hotpath_napi.dylib'),
  path.join(targetRelease, 'deps', 'librouter_hotpath_napi.so'),
  path.join(targetRelease, 'deps', 'router_hotpath_napi.dll'),
  path.join(targetRelease, 'librouter_hotpath_napi.dylib'),
  path.join(targetRelease, 'librouter_hotpath_napi.so'),
  path.join(targetRelease, 'router_hotpath_napi.dll')
];
const cargoBinFromEnv = typeof process.env.CARGO === 'string' ? process.env.CARGO.trim() : '';
const cargoBinFromHome =
  typeof process.env.HOME === 'string' && process.env.HOME.trim()
    ? path.join(process.env.HOME.trim(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
    : '';
const cargoBinary = resolveCargoBinary();

function readBoolEnv(name) {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function resolveCargoTargetRoot() {
  const configured = String(process.env.CARGO_TARGET_DIR || '').trim();
  if (!configured) {
    return path.join(rustRoot, 'target');
  }
  return path.isAbsolute(configured) ? configured : path.resolve(rustRoot, configured);
}

function resolveCargoBinary() {
  const candidates = [];
  if (cargoBinFromEnv) candidates.push(cargoBinFromEnv);
  candidates.push('cargo');
  if (cargoBinFromHome) candidates.push(cargoBinFromHome);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe', cwd: projectRoot });
    if ((probe.status ?? 1) === 0) {
      return candidate;
    }
  }
  return 'cargo';
}

function walkLatestMtime(entryPath) {
  if (!fs.existsSync(entryPath)) {
    return 0;
  }
  const stat = fs.statSync(entryPath);
  if (stat.isDirectory()) {
    let latest = 0;
    const entries = fs.readdirSync(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'target' || entry.name === '.git') {
        continue;
      }
      latest = Math.max(latest, walkLatestMtime(path.join(entryPath, entry.name)));
    }
    return latest;
  }
  return stat.mtimeMs || 0;
}

function getLatestSourceMtime() {
  // Primary crate (router-hotpath-napi) + workspace root
  const candidates = [
    path.join(rustRoot, 'Cargo.toml'),
    path.join(rustRoot, 'Cargo.lock'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'Cargo.toml'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'build.rs'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'src'),
    path.join(rustRoot, 'crates', 'servertool-cli', 'Cargo.toml'),
    path.join(rustRoot, 'crates', 'servertool-cli', 'src'),
  ];
  // Dependency crates — changes in these also require a rebuild
  const depCrates = [
    'stop-message-core',
    'servertool-core',
    'followup-core',
  ];
  for (const crate of depCrates) {
    const crateSrc = path.join(rustRoot, 'crates', crate, 'src');
    if (fs.existsSync(crateSrc)) {
      candidates.push(crateSrc);
    }
  }
  return candidates.reduce((latest, item) => Math.max(latest, walkLatestMtime(item)), 0);
}

function getRequiredArtifactMtime() {
  const primaryNative = resolvePrimaryNativeArtifact();
  if (!primaryNative || !fs.existsSync(releaseServertoolBinary)) {
    return 0;
  }
  return Math.min(
    fs.statSync(primaryNative).mtimeMs || 0,
    fs.statSync(releaseServertoolBinary).mtimeMs || 0
  );
}

function hasReleaseArtifact() {
  return Boolean(resolvePrimaryNativeArtifact()) && fs.existsSync(releaseServertoolBinary);
}

function resolvePrimaryNativeArtifact() {
  const candidates =
    process.platform === 'darwin'
      ? [
          path.join(targetRelease, 'deps', 'librouter_hotpath_napi.dylib'),
          path.join(targetRelease, 'librouter_hotpath_napi.dylib')
        ]
      : process.platform === 'win32'
        ? [
            path.join(targetRelease, 'deps', 'router_hotpath_napi.dll'),
            path.join(targetRelease, 'router_hotpath_napi.dll')
          ]
        : [
            path.join(targetRelease, 'deps', 'librouter_hotpath_napi.so'),
            path.join(targetRelease, 'librouter_hotpath_napi.so')
          ];

  return candidates.find((item) => fs.existsSync(item));
}

function syncNodeBridgeArtifact() {
  const primary = resolvePrimaryNativeArtifact();
  if (!primary || !fs.existsSync(primary)) {
    return;
  }

  const nodeTarget = path.join(targetRelease, 'router_hotpath_napi.node');
  const tempTarget = `${nodeTarget}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(primary, tempTarget);
  fs.renameSync(tempTarget, nodeTarget);
  console.log(`[native-build] synced node bridge: ${path.basename(primary)} -> ${path.basename(nodeTarget)}`);

  fs.mkdirSync(distNativeDir, { recursive: true });
  const packageTempTarget = `${packagedNodeTarget}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(nodeTarget, packageTempTarget);
  fs.renameSync(packageTempTarget, packagedNodeTarget);
  console.log(
    `[native-build] packaged native: ${path.basename(nodeTarget)} -> ${path.relative(projectRoot, packagedNodeTarget)}`
  );
}

function syncServertoolBinaryArtifact() {
  if (!fs.existsSync(releaseServertoolBinary)) {
    console.error(`[native-build] missing servertool binary: ${releaseServertoolBinary}`);
    process.exit(1);
  }
  fs.mkdirSync(distBinDir, { recursive: true });
  const tempTarget = `${packagedServertoolBinary}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(releaseServertoolBinary, tempTarget);
  fs.chmodSync(tempTarget, 0o755);
  fs.renameSync(tempTarget, packagedServertoolBinary);
  console.log(
    `[native-build] packaged servertool binary: ${path.basename(releaseServertoolBinary)} -> ${path.relative(projectRoot, packagedServertoolBinary)}`
  );
}

function readRequiredNativeExports() {
  if (!fs.existsSync(requiredNativeExportsSource)) {
    console.error(`[native-build] missing required export contract: ${requiredNativeExportsSource}`);
    process.exit(1);
  }
  const source = fs.readFileSync(requiredNativeExportsSource, 'utf8');
  const exports = [...new Set([...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]))].filter(Boolean);
  if (!exports.includes('compileRouteCodexRuntimeManifestJson')) {
    console.error('[native-build] required export contract missing compileRouteCodexRuntimeManifestJson');
    process.exit(1);
  }
  return exports;
}

function validatePackagedNativeExports() {
  const requiredExports = readRequiredNativeExports();
  let binding;
  try {
    const resolved = requireFromProject.resolve(packagedNodeTarget);
    delete requireFromProject.cache?.[resolved];
    binding = requireFromProject(packagedNodeTarget);
  } catch (error) {
    return {
      ok: false,
      reason: `native binding failed to load: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const missing = requiredExports.filter((key) => typeof binding?.[key] !== 'function');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `native binding missing required exports: ${missing.slice(0, 12).join(', ')}`
    };
  }
  return { ok: true, reason: '' };
}

function removeNativeReleaseArtifacts() {
  for (const artifact of [...releaseArtifacts, packagedNodeTarget]) {
    fs.rmSync(artifact, { force: true });
  }
}

function ensureCargoReady() {
  const probe = spawnSync(cargoBinary, ['--version'], { stdio: 'pipe', cwd: projectRoot });
  if ((probe.status ?? 1) !== 0) {
    console.error(
      `[native-build] cargo is required but unavailable (PATH/HOME fallback all failed). tried=${[
        cargoBinFromEnv || '(env:CARGO empty)',
        'cargo',
        cargoBinFromHome || '(HOME/.cargo/bin/cargo unavailable)'
      ].join(', ')}`
    );
    process.exit(probe.status ?? 1);
  }
}

function runCargoBuild() {
  const args = ['build', '-p', 'router-hotpath-napi', '-p', 'servertool-cli', '--release'];
  console.log(`[native-build] run: ${cargoBinary} ${args.join(' ')}`);
  const result = spawnSync(cargoBinary, args, { stdio: 'inherit', cwd: rustRoot });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  if (readBoolEnv('LLMS_NATIVE_BUILD_SKIP') || readBoolEnv('ROUTECODEX_LLMS_NATIVE_BUILD_SKIP')) {
    console.log('[native-build] skipped by env');
    return;
  }

  if (!fs.existsSync(cargoManifest)) {
    console.error(`[native-build] missing rust manifest: ${cargoManifest}`);
    process.exit(1);
  }

  const latestSource = getLatestSourceMtime();
  const latestArtifact = getRequiredArtifactMtime();
  if (latestArtifact > 0 && latestArtifact >= latestSource) {
    syncNodeBridgeArtifact();
    syncServertoolBinaryArtifact();
    const validation = validatePackagedNativeExports();
    if (validation.ok) {
      console.log('[native-build] required native exports ok');
      console.log('[native-build] up-to-date, skip cargo build');
      return;
    }
    console.error(`[native-build] stale native artifact rejected: ${validation.reason}`);
    removeNativeReleaseArtifacts();
  }

  ensureCargoReady();
  runCargoBuild();

  if (!hasReleaseArtifact()) {
    console.error('[native-build] cargo build finished but no native artifact was produced');
    process.exit(1);
  }

  syncNodeBridgeArtifact();
  syncServertoolBinaryArtifact();
  const validation = validatePackagedNativeExports();
  if (!validation.ok) {
    console.error(`[native-build] native export validation failed: ${validation.reason}`);
    process.exit(1);
  }
  console.log('[native-build] required native exports ok');
  console.log('[native-build] ready');
}

main();
