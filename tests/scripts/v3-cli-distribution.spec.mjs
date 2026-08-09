import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import test from 'node:test';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const cargo = read('v3/crates/routecodex-v3-cli/Cargo.toml');
const copyScript = read('scripts/copy-v3-cli-bin.mjs');
const packScript = read('scripts/pack-v3-release.mjs');
const shimScript = read('scripts/ensure-cli-command-shim.mjs');
const executableScript = read('scripts/ensure-cli-executable.mjs');
const globalInstall = read('scripts/install-global.sh');
const releaseInstall = read('scripts/install-release.sh');
const installV3Script = read('scripts/install-v3-cli.mjs');
const v3ConfigSource = read('v3/crates/routecodex-v3-config/src/lib.rs');

test('publishes the V3 Rust binary as the default generated command surface', () => {
  assert.deepEqual(packageJson.bin, {
    routecodex: 'dist/bin/rccv3',
    rcc: 'dist/bin/rccv3',
    rccv3: 'dist/bin/rccv3',
  });
  assert.ok(cargo.includes('name = "rccv3"'));
  assert.ok(copyScript.includes("process.platform === 'win32' ? 'rccv3.exe' : 'rccv3'"));
  assert.ok(copyScript.includes("path.join(root, 'dist', 'bin'"));
  assert.ok(copyScript.includes('legacyTargetBin'));
  assert.ok(copyScript.includes('fs.rmSync(legacyTargetBin, { force: true })'));
  assert.ok(packScript.includes('bin: {'));
  assert.ok(packScript.includes("routecodex: 'dist/bin/rccv3'"));
  assert.ok(packScript.includes("rcc: 'dist/bin/rccv3'"));
  assert.ok(packScript.includes("rccv3: 'dist/bin/rccv3'"));
  assert.ok(packScript.includes('bash install.sh'));
  assert.ok(packScript.includes('Provides: rccv3, rcc, routecodex (all symlinked to the same V3 binary)'));
  assert.ok(packScript.includes('[pack-v3-release]'));
  assert.ok(packScript.includes("process.platform === 'win32' ? 'rccv3.exe' : 'rccv3'"));
  assert.ok(packageJson.scripts['test:v3-cli-distribution'].includes(
    'tests/scripts/v3-cli-distribution.spec.mjs',
  ));
  assert.ok(packageJson.scripts['build:v3-cli'].includes('npm run test:v3-cli-distribution'));
});

test('installs, shims, and verifies rcc/rccv3 globally through the V3-only default path', () => {
  assert.ok(shimScript.includes("installDirectNativeCommand(shimDir, 'routecodex', binaryPath)"));
  assert.ok(shimScript.includes("installDirectNativeCommand(shimDir, 'rcc', binaryPath)"));
  assert.ok(shimScript.includes("installDirectNativeCommand(shimDir, 'rccv3', binaryPath)"));
  assert.ok(!shimScript.includes('ROUTECODEX_V3_DEV_DEFAULT_SNAP=1'));
  assert.ok(!shimScript.includes('ROUTECODEX_V3_DEV_DEFAULT_DEBUG=1'));
  assert.ok(shimScript.includes("removeLegacyShim(shimDir, 'routecodex-v3')"));
  assert.ok(shimScript.includes('removeExistingShimPath(shimPath)'));
  assert.ok(shimScript.includes('fs.lstatSync(shimPath)'));
  assert.ok(shimScript.includes('fs.rmSync(shimPath, { force: true })'));
  assert.ok(!shimScript.includes('install/current'));
  assert.ok(executableScript.includes("path.join(process.cwd(), 'dist', 'bin', 'rccv3')"));
  assert.ok(executableScript.includes("ensureGlobalBinTarget('rccv3')"));
  assert.ok(executableScript.includes("ensureGlobalBinTarget('rcc')"));
  assert.ok(globalInstall.includes('local expected_bin="$HOME/.local/bin/rccv3"'));
  assert.ok(globalInstall.includes('verify_direct_v3_install'));
  assert.ok(globalInstall.includes('run_default_v3_install'));
  assert.ok(globalInstall.includes('node scripts/install-v3-cli.mjs'));
  const defaultV3InstallBody = globalInstall.slice(
    globalInstall.indexOf('run_default_v3_install()'),
    globalInstall.indexOf('# 主函数'),
  );
  assert.ok(defaultV3InstallBody.includes('node scripts/cleanup-stale-server-pids.mjs --quiet'));
  assert.ok(!defaultV3InstallBody.includes('cleanup-stale-server-pids.mjs --quiet || true'));
  assert.ok(defaultV3InstallBody.includes('npm run test:install-v3-target-cleanup'));
  assert.ok(defaultV3InstallBody.includes('cleanup_retired_v2_install'));
  assert.ok(defaultV3InstallBody.includes('node scripts/ensure-cli-command-shim.mjs'));
  assert.ok(!defaultV3InstallBody.includes('ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT'));
  assert.ok(globalInstall.includes('routecodex restart -c "$restart_config"'));
  assert.ok(!globalInstall.includes('routecodex restart --port "$restart_port"'));
  assert.ok(!globalInstall.includes('V3 install target missing current rccv3'));
  assert.ok(!releaseInstall.includes('V3 install target missing current rccv3'));
  const installV3Cli = read('scripts/install-v3-cli.mjs');
  assert.ok(installV3Cli.includes("return path.join(resolveHomeDir(), '.local', 'bin')"));
  assert.ok(installV3Cli.includes('path.join(resolveInstallBinDir(), binaryName)'));
  assert.ok(!installV3Cli.includes('ROUTECODEX_V3_INSTALL_BIN_DIR'));
  assert.ok(!installV3Cli.includes('RCC_V3_INSTALL_BIN_DIR'));
  assert.ok(installV3Cli.includes('env.ROUTECODEX_BUILD_VERSION = readPackageVersion()'));
  assert.ok(globalInstall.includes('local retired_install="$HOME/.rcc/install"'));
  assert.ok(globalInstall.includes('rm -rf "$retired_install"'));
  assert.ok(v3ConfigSource.includes('option_env!("ROUTECODEX_BUILD_VERSION")'));
  assert.ok(v3ConfigSource.includes('ROUTECODEX_BUILD_VERSION must be embedded at compile time'));
  assert.ok(!v3ConfigSource.includes('std::env::var("ROUTECODEX_VERSION")'));
  assert.ok(!v3ConfigSource.includes('read_nearest_routecodex_package_version'));
  assert.ok(!installV3Cli.includes('V3 install target missing current rccv3'));
  assert.ok(!installV3Cli.includes("'install', 'current'"));
  assert.ok(!installV3Cli.includes('copyPackageJsonAtomic'));
  assert.ok(globalInstall.includes('command -v rccv3'));
  assert.ok(globalInstall.includes('command -v routecodex'));
  assert.ok(globalInstall.includes('command -v rcc'));
  assert.ok(globalInstall.includes('routecodex_version="$(routecodex --version)"'));
  assert.ok(globalInstall.includes('rcc_version="$(rcc --version)"'));
  assert.ok(globalInstall.includes('"$routecodex_version" != "$rccv3_version"'));
  assert.ok(releaseInstall.includes('rccv3 --help'));
  assert.ok(globalInstall.includes('rcc --version'));
  assert.ok(releaseInstall.includes('run_default_v3_release_install'));
  assert.ok(releaseInstall.includes('node scripts/install-v3-cli.mjs'));
  assert.ok(releaseInstall.includes('rcc restart -c "$VERIFY_CONFIG"'));
  assert.ok(releaseInstall.includes('V3 release 验证缺少配置文件'));
  assert.ok(releaseInstall.includes('command -v rccv3'));
  assert.ok(releaseInstall.includes('command -v rcc'));
  assert.ok(releaseInstall.includes('rccv3 --help'));
  assert.ok(globalInstall.includes('V3 command identity'));
  assert.ok(globalInstall.includes('.local/bin/rccv3'));
  assert.ok(releaseInstall.includes('默认 V3 产物 $INSTALL_BUILD_ROOT/dist/bin/rccv3'));
  assert.ok(!globalInstall.includes('INSTALL_V2_MODE'));
  assert.ok(!releaseInstall.includes('INSTALL_V2_MODE'));
  assert.ok(releaseInstall.includes('.gitignore .github AGENTS.md'));
  assert.ok(!globalInstall.includes('command -v routecodex-v3'));
  assert.ok(!releaseInstall.includes('command -v routecodex-v3'));
});

test('behaviorally locks direct command aliases to one binary without fallback', () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-shim-test-'));
  const binaryPath = path.join(shimDir, 'rccv3');
  const shimScriptPath = path.resolve('scripts/ensure-cli-command-shim.mjs');
  const sourceBinaryPath = path.resolve('dist/bin/rccv3');
  try {
    fs.copyFileSync(sourceBinaryPath, binaryPath);
    fs.chmodSync(binaryPath, 0o755);
    const install = spawnSync(process.execPath, [shimScriptPath], {
      cwd: root,
      env: { ...process.env, ROUTECODEX_SHIM_DIR: shimDir },
      encoding: 'utf8',
    });
    assert.equal(install.status, 0);
    for (const commandName of ['routecodex', 'rcc', 'rccv3']) {
      const commandPath = path.join(shimDir, commandName);
      assert.equal(fs.existsSync(commandPath), true);
      assert.equal(fs.realpathSync(commandPath), fs.realpathSync(binaryPath));
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(commandPath)).digest('hex'),
        crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'));
      const result = spawnSync(commandPath, ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes('rccv3 '));
    }
    fs.unlinkSync(binaryPath);
    const missing = spawnSync(path.join(shimDir, 'routecodex'), ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(missing.status, 0);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('rejects unsupported release mode before mutating package metadata', () => {
  const packageBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const result = spawnSync(
    process.execPath,
    ['scripts/pack-v3-release.mjs', '--mode', 'custom-rcc'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes('[pack-v3-release] unknown mode:'));
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), packageBefore);
  assert.equal(fs.existsSync(path.join(root, 'package.json.bak.pack')), false);
});

test('runs V3 install preflight gates and cargo build inside one isolated target dir', () => {
  assert.ok(installV3Script.includes('function buildV3CargoEnv(sourceEnv = process.env)'));
  assert.ok(installV3Script.includes("fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-install-target-'))"));
  assert.ok(installV3Script.includes('env.CARGO_TARGET_DIR = cargoTargetDir'));
  assert.ok(!installV3Script.includes("env.ROUTECODEX_SKIP_AUTO_BUMP = '1'"));
  const envStart = installV3Script.indexOf('const { env, cargoTargetDir } = build;');
  const architectureGate = installV3Script.indexOf('V3 install resource-map gate');
  const semanticGate = installV3Script.indexOf('V3 CLI distribution gate');
  const buildVersionRefresh = installV3Script.indexOf(
    'env.ROUTECODEX_BUILD_VERSION = readPackageVersion();',
    installV3Script.indexOf('build-info/version generation'),
  );
  const cargoBuild = installV3Script.indexOf('cargo build for routecodex-v3-cli');
  assert.ok(envStart > -1);
  assert.ok(envStart < architectureGate);
  assert.ok(envStart < semanticGate);
  assert.ok(buildVersionRefresh > semanticGate);
  assert.ok(buildVersionRefresh < cargoBuild);
  assert.ok(envStart < cargoBuild);
});
