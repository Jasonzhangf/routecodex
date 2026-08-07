#!/usr/bin/env node
/**
 * V3 release packer.
 *
 * Modes:
 *   --mode dev     Binary tarball: dist/bin/rccv3 + install.sh (copies to
 *                  ~/.local/bin and creates rcc/routecodex symlinks). No npm
 *                  registry dependency; installs to the global bin dir, never
 *                  into ~/.rcc.
 *   --mode npm     V3-only npm package tarball: rccv3 binary + package.json
 *                  bin entries (routecodex/rcc/rccv3 -> dist/bin/rccv3).
 *                  No V2 llms dependency tree is bundled.
 *
 * Output goes to artifacts/pack/.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const manifestPath = path.join(repoRoot, 'v3', 'Cargo.toml');
const binaryName = process.platform === 'win32' ? 'rccv3.exe' : 'rccv3';
const repoBin = path.join(repoRoot, 'dist', 'bin', binaryName);
const packDir = path.join(repoRoot, 'artifacts', 'pack');

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!version) throw new Error('package.json version missing');
  return version;
}

function fail(message) {
  console.error(`[pack-v3-release] ${message}`);
  process.exit(2);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function buildV3Cli() {
  const env = { ...process.env };
  if (!Object.prototype.hasOwnProperty.call(env, 'RUSTUP_TOOLCHAIN')) {
    env.RUSTUP_TOOLCHAIN = 'stable';
  }
  if (!Object.prototype.hasOwnProperty.call(env, 'CARGO_NET_OFFLINE')) {
    env.CARGO_NET_OFFLINE = 'true';
  }
  env.ROUTECODEX_BUILD_VERSION = readPackageVersion();
  run('cargo', ['build', '--manifest-path', manifestPath, '-p', 'routecodex-v3-cli'], { env });
  if (!fs.existsSync(repoBin)) {
    fail(`missing built binary: ${repoBin}`);
  }
  console.log(`[pack-v3-release] built ${repoBin} sha256=${sha256(repoBin)}`);
}

function ensurePackDir() {
  fs.mkdirSync(packDir, { recursive: true });
}

function writeInstallSh(version) {
  const installSh = `#!/usr/bin/env bash
set -euo pipefail

# RouteCodex V3 installer (binary tarball).
# Installs the rccv3 binary into the global bin dir (~/.local/bin by default)
# and creates rcc / routecodex symlinks. Never writes into ~/.rcc.
#
# Usage: bash install.sh [--bin-dir <dir>]

BIN_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BIN_DIR" ]]; then
  BIN_DIR="$HOME/.local/bin"
fi

mkdir -p "$BIN_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_BIN="$SCRIPT_DIR/bin/rccv3"
if [[ ! -f "$SRC_BIN" ]]; then
  echo "missing rccv3 binary at $SRC_BIN" >&2
  exit 2
fi

DEST="$BIN_DIR/rccv3"
cp "$SRC_BIN" "$DEST"
chmod 755 "$DEST"
ln -sfn rccv3 "$BIN_DIR/rcc"
ln -sfn rccv3 "$BIN_DIR/routecodex"

VERSION="$($DEST --version 2>/dev/null || echo '${version}')"
echo "installed rccv3 -> $DEST ($VERSION)"
echo "shims: $BIN_DIR/rcc, $BIN_DIR/routecodex"
echo "ensure $BIN_DIR is in your PATH"
`;
  return installSh;
}

function packDevTarball(version) {
  ensurePackDir();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rccv3-dev-pack-'));
  try {
    const pkgRoot = path.join(tmpDir, `routecodex-v3-${version}`);
    fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
    fs.copyFileSync(repoBin, path.join(pkgRoot, 'bin', binaryName));
    fs.writeFileSync(path.join(pkgRoot, 'install.sh'), writeInstallSh(version));
    fs.chmodSync(path.join(pkgRoot, 'install.sh'), 0o755);
    fs.writeFileSync(
      path.join(pkgRoot, 'README.md'),
      [
        `# RouteCodex V3 ${version}`,
        '',
        'Binary release. Install to the global bin dir:',
        '',
        '```bash',
        'bash install.sh',
        '# or: bash install.sh --bin-dir <dir>',
        '```',
        '',
        'Provides: rccv3, rcc, routecodex (all symlinked to the same V3 binary).',
        '',
      ].join('\n')
    );
    const tarballName = `routecodex-v3-${version}-${process.platform}-${process.arch}.tar.gz`;
    const tarballPath = path.join(packDir, tarballName);
    run('tar', ['-czf', tarballPath, '-C', tmpDir, path.basename(pkgRoot)]);
    console.log(`[pack-v3-release] dev tarball: ${tarballPath}`);
    return tarballPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function packNpmTarball(version) {
  ensurePackDir();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rccv3-npm-pack-'));
  try {
    const pkgRoot = path.join(tmpDir, 'package');
    fs.mkdirSync(path.join(pkgRoot, 'dist', 'bin'), { recursive: true });
    fs.copyFileSync(repoBin, path.join(pkgRoot, 'dist', 'bin', binaryName));
    fs.chmodSync(path.join(pkgRoot, 'dist', 'bin', binaryName), 0o755);
    const pkg = {
      name: 'routecodex',
      version,
      description: 'RouteCodex V3 (Rust-only) unified CLI',
      license: 'MIT',
      bin: {
        routecodex: 'dist/bin/rccv3',
        rcc: 'dist/bin/rccv3',
        rccv3: 'dist/bin/rccv3',
      },
      files: ['dist/bin'],
      engines: { node: '>=20' },
    };
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    fs.writeFileSync(
      path.join(pkgRoot, 'README.md'),
      [
        `# RouteCodex V3 ${version}`,
        '',
        'V3-only npm package. After install, `rccv3`, `rcc`, and `routecodex`',
        'commands are available in your npm global bin dir. No V2 runtime is bundled.',
        '',
      ].join('\n')
    );
    const tarballName = `routecodex-v3-${version}.tgz`;
    const tarballPath = path.join(packDir, tarballName);
    run('npm', ['pack', '--silent'], { cwd: pkgRoot });
    const npmTarballName = `routecodex-${version}.tgz`;
    const packed = path.join(pkgRoot, npmTarballName);
    if (!fs.existsSync(packed)) {
      fail(`npm pack output missing: ${packed}`);
    }
    fs.copyFileSync(packed, tarballPath);
    console.log(`[pack-v3-release] npm tarball: ${tarballPath}`);
    return tarballPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
const mode = modeIndex !== -1 ? args[modeIndex + 1] : 'dev';
if (!['dev', 'npm'].includes(mode)) {
  fail(`unknown mode: ${mode} (expected dev or npm)`);
}

try {
  buildV3Cli();
  const version = readPackageVersion();
  const tarball = mode === 'dev' ? packDevTarball(version) : packNpmTarball(version);
  console.log(`[pack-v3-release] ok mode=${mode} version=${version}`);
  console.log(`[pack-v3-release] artifact=${tarball}`);
} catch (error) {
  console.error(`[pack-v3-release] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
