#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rustRoot = path.join(projectRoot, 'rust-core');
const cargoManifest = path.join(rustRoot, 'Cargo.toml');
const targetRelease = path.join(rustRoot, 'target', 'release');
const distNativeDir = path.join(projectRoot, 'dist', 'native');
const packagedNodeTarget = path.join(distNativeDir, 'router_hotpath_napi.node');
const releaseArtifacts = [
  path.join(targetRelease, 'router_hotpath_napi.node'),
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
  const candidates = [
    path.join(rustRoot, 'Cargo.toml'),
    path.join(rustRoot, 'Cargo.lock'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'Cargo.toml'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'build.rs'),
    path.join(rustRoot, 'crates', 'router-hotpath-napi', 'src')
  ];
  return candidates.reduce((latest, item) => Math.max(latest, walkLatestMtime(item)), 0);
}

function getLatestArtifactMtime() {
  let latest = 0;
  for (const artifact of releaseArtifacts) {
    if (!fs.existsSync(artifact)) {
      continue;
    }
    const mtime = fs.statSync(artifact).mtimeMs || 0;
    latest = Math.max(latest, mtime);
  }
  return latest;
}

function hasReleaseArtifact() {
  return releaseArtifacts.some((file) => fs.existsSync(file));
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
  const args = ['build', '-p', 'router-hotpath-napi', '--release'];
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
  const latestArtifact = getLatestArtifactMtime();
  if (latestArtifact > 0 && latestArtifact >= latestSource) {
    syncNodeBridgeArtifact();
    console.log('[native-build] up-to-date, skip cargo build');
    return;
  }

  ensureCargoReady();
  runCargoBuild();

  if (!hasReleaseArtifact()) {
    console.error('[native-build] cargo build finished but no native artifact was produced');
    process.exit(1);
  }

  syncNodeBridgeArtifact();
  console.log('[native-build] ready');
}

main();
