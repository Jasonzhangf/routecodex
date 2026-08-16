#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(v3Root, 'Cargo.toml');
const packageJsonPath = path.join(v3Root, 'package.json');
const isolationGate = path.join(v3Root, 'scripts', 'verify-isolation.mjs');
const binaryName = process.platform === 'win32' ? 'rccv3.exe' : 'rccv3';
const repoBin = path.join(v3Root, 'dist', 'bin', binaryName);
const packControlRoot = path.join(v3Root, 'build-control', 'pack');
const packArtifactRoot = path.join(v3Root, 'artifacts', 'pack');

function fail(message) {
  throw new Error(message);
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) fail(`V3 package version missing: ${packageJsonPath}`);
  return version;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? v3Root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  return result;
}

function signExecutable(filePath) {
  if (process.platform === 'win32') return;
  run('codesign', ['-s', '-', '-f', filePath], { encoding: 'utf8' });
}

function copyExecutableAtomic(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(sourcePath, temporaryPath);
  if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o755);
  signExecutable(temporaryPath);
  fs.renameSync(temporaryPath, targetPath);
}

function publishArtifact(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(sourcePath, temporaryPath);
  fs.renameSync(temporaryPath, targetPath);
}

function installScript(version) {
  return `#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$BIN_DIR" ]] || BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_BIN="$SCRIPT_DIR/bin/rccv3"
[[ -f "$SRC_BIN" ]] || { echo "missing rccv3 binary at $SRC_BIN" >&2; exit 2; }
TMP_BIN="$BIN_DIR/.rccv3.$$.$RANDOM.tmp"
trap 'rm -f "$TMP_BIN"' EXIT INT TERM
cp "$SRC_BIN" "$TMP_BIN"
chmod 755 "$TMP_BIN"
if [[ "$(uname -s)" == "Darwin" ]]; then codesign -s - -f "$TMP_BIN"; fi
mv -f "$TMP_BIN" "$BIN_DIR/rccv3"
ln -sfn rccv3 "$BIN_DIR/rcc"
ln -sfn rccv3 "$BIN_DIR/routecodex"
trap - EXIT INT TERM
echo "installed RouteCodex V3 ${version} to $BIN_DIR/rccv3"
`;
}

function buildReleaseBinary(runRoot, version) {
  run(process.execPath, [isolationGate]);
  const cargoTarget = path.join(runRoot, 'cargo-target');
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: cargoTarget,
    CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true',
    ROUTECODEX_BUILD_VERSION: version,
  };
  run('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    manifestPath,
    '-p',
    'routecodex-v3-cli',
  ], { env });
  const sourceBin = path.join(cargoTarget, 'release', binaryName);
  if (!fs.existsSync(sourceBin)) fail(`built V3 CLI binary missing: ${sourceBin}`);
  copyExecutableAtomic(sourceBin, repoBin);
  process.stdout.write(`[pack-release] binary=${path.relative(v3Root, repoBin)} sha256=${sha256(repoBin)}\n`);
}

function packDev(runRoot, version) {
  const releaseRoot = path.join(runRoot, `routecodex-v3-${version}`);
  fs.mkdirSync(path.join(releaseRoot, 'bin'), { recursive: true });
  fs.copyFileSync(repoBin, path.join(releaseRoot, 'bin', binaryName));
  fs.writeFileSync(path.join(releaseRoot, 'install.sh'), installScript(version), { mode: 0o755 });
  fs.writeFileSync(
    path.join(releaseRoot, 'README.md'),
    `# RouteCodex V3 ${version}\n\nRun \`bash install.sh\` to publish rccv3, rcc, and routecodex.\n`,
  );
  const artifactName = `routecodex-v3-${version}-${process.platform}-${process.arch}.tar.gz`;
  const stagedArtifact = path.join(runRoot, artifactName);
  run('tar', ['-czf', stagedArtifact, '-C', runRoot, path.basename(releaseRoot)]);
  const artifactPath = path.join(packArtifactRoot, artifactName);
  publishArtifact(stagedArtifact, artifactPath);
  return artifactPath;
}

function packNpm(runRoot, version) {
  const packageRoot = path.join(runRoot, 'package');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'bin'), { recursive: true });
  fs.copyFileSync(repoBin, path.join(packageRoot, 'dist', 'bin', binaryName));
  if (process.platform !== 'win32') fs.chmodSync(path.join(packageRoot, 'dist', 'bin', binaryName), 0o755);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'routecodex',
    version,
    description: 'RouteCodex V3 self-contained Rust CLI',
    license: 'MIT',
    bin: {
      routecodex: 'dist/bin/rccv3',
      rcc: 'dist/bin/rccv3',
      rccv3: 'dist/bin/rccv3',
    },
    files: ['dist/bin'],
    engines: { node: '>=20 <26' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(packageRoot, 'README.md'), `# RouteCodex V3 ${version}\n`);
  const npmOutput = path.join(runRoot, 'npm-output');
  fs.mkdirSync(npmOutput, { recursive: true });
  run('npm', ['pack', '--silent', '--pack-destination', npmOutput], { cwd: packageRoot });
  const packedPath = path.join(npmOutput, `routecodex-${version}.tgz`);
  if (!fs.existsSync(packedPath)) fail(`npm pack output missing: ${packedPath}`);
  const artifactPath = path.join(packArtifactRoot, `routecodex-v3-${version}.tgz`);
  publishArtifact(packedPath, artifactPath);
  return artifactPath;
}

const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
const mode = modeIndex === -1 ? 'dev' : args[modeIndex + 1];
if (!['dev', 'npm'].includes(mode)) {
  process.stderr.write(`[pack-release] unknown mode: ${mode} (expected dev or npm)\n`);
  process.exitCode = 2;
} else {
  fs.mkdirSync(packControlRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(packControlRoot, 'run-'));
  try {
    const version = readVersion();
    buildReleaseBinary(runRoot, version);
    const artifact = mode === 'dev' ? packDev(runRoot, version) : packNpm(runRoot, version);
    process.stdout.write(`[pack-release] PASS mode=${mode} version=${version} artifact=${artifact} sha256=${sha256(artifact)}\n`);
  } catch (error) {
    process.stderr.write(`[pack-release] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}
