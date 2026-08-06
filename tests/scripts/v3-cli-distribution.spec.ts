import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

describe('V3 CLI distribution surface', () => {
  const root = process.cwd();
  const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');
  const packageJson = JSON.parse(read('package.json'));
  const cargo = read('v3/crates/routecodex-v3-cli/Cargo.toml');
  const copyScript = read('scripts/copy-v3-cli-bin.mjs');
  const packScript = read('scripts/pack-mode.mjs');
  const shimScript = read('scripts/ensure-cli-command-shim.mjs');
  const executableScript = read('scripts/ensure-cli-executable.mjs');
  const globalInstall = read('scripts/install-global.sh');
  const releaseInstall = read('scripts/install-release.sh');
  const releaseVerifier = read('scripts/verify-rcc-release-install.mjs');
  const installV3Script = read('scripts/install-v3-cli.mjs');
  const v3ConfigSource = read('v3/crates/routecodex-v3-config/src/lib.rs');

  it('publishes the V3 Rust binary as the default generated command surface', () => {
    expect(packageJson.bin).toEqual({
      routecodex: 'dist/bin/rccv3',
      rcc: 'dist/bin/rccv3',
      rccv3: 'dist/bin/rccv3',
    });
    expect(cargo).toContain('name = "rccv3"');
    expect(copyScript).toContain("process.platform === 'win32' ? 'rccv3.exe' : 'rccv3'");
    expect(copyScript).toContain("path.join(root, 'dist', 'bin'");
    expect(copyScript).toContain('legacyTargetBin');
    expect(copyScript).toContain('fs.rmSync(legacyTargetBin, { force: true })');
    expect(packScript).toContain("const v3BinEntries = {");
    expect(packScript).toContain("routecodex: 'dist/bin/rccv3'");
    expect(packScript).toContain("rcc: 'dist/bin/rccv3'");
    expect(packScript).toContain("rccv3: 'dist/bin/rccv3'");
    expect(packScript).toContain("mutated.bin = { ...v3BinEntries }");
    expect(packScript).toContain("args.name === 'routecodex' && args.bin === 'routecodex'");
    expect(packScript).toContain("args.name === 'rcc' && args.bin === 'rcc'");
    expect(packScript).toContain("args.v2 === true");
    expect(packScript).toContain("mutated.bin = { rccv2: 'dist/cli.js' }");
    expect(packScript).toContain('[pack-mode] unsupported release identity:');
    expect(packScript).not.toContain("mutated.bin['routecodex-v3']");
    expect(packageJson.scripts['test:v3-cli-distribution']).toContain(
      'tests/scripts/v3-cli-distribution.spec.ts',
    );
    expect(packageJson.scripts['build:v3-cli']).toContain('npm run test:v3-cli-distribution');
  });

  it('installs, shims, and verifies rcc/rccv3 globally through the V3-only default path', () => {
    expect(shimScript).toContain("installDirectNativeCommand(shimDir, 'routecodex', binaryPath)");
    expect(shimScript).toContain("installDirectNativeCommand(shimDir, 'rcc', binaryPath)");
    expect(shimScript).toContain("installDirectNativeCommand(shimDir, 'rccv3', binaryPath)");
    expect(shimScript).not.toContain("ROUTECODEX_V3_DEV_DEFAULT_SNAP=1");
    expect(shimScript).not.toContain("ROUTECODEX_V3_DEV_DEFAULT_DEBUG=1");
    expect(shimScript).toContain("removeLegacyShim(shimDir, 'routecodex-v3')");
    expect(shimScript).toContain('removeExistingShimPath(shimPath)');
    expect(shimScript).toContain('fs.lstatSync(shimPath)');
    expect(shimScript).toContain('fs.rmSync(shimPath, { force: true })');
    expect(shimScript).not.toContain('install/current');
    expect(executableScript).toContain("path.join(process.cwd(), 'dist', 'bin', 'rccv3')");
    expect(executableScript).toContain("ensureGlobalBinTarget('rccv3')");
    expect(executableScript).toContain("ensureGlobalBinTarget('rcc')");
    expect(globalInstall).toContain('local expected_bin="$HOME/.local/bin/rccv3"');
    expect(globalInstall).toContain('verify_direct_v3_install');
    expect(globalInstall).toContain('run_default_v3_install');
    expect(globalInstall).toContain('node scripts/install-v3-cli.mjs');
    const defaultV3InstallBody = globalInstall.slice(
      globalInstall.indexOf('run_default_v3_install()'),
      globalInstall.indexOf('# 主函数'),
    );
    expect(defaultV3InstallBody).toContain('node scripts/cleanup-stale-server-pids.mjs --quiet');
    expect(defaultV3InstallBody).not.toContain('cleanup-stale-server-pids.mjs --quiet || true');
    expect(defaultV3InstallBody).toContain('npm run test:install-v3-target-cleanup');
    expect(defaultV3InstallBody).toContain('cleanup_retired_v2_install');
    expect(defaultV3InstallBody).toContain('node scripts/ensure-cli-command-shim.mjs');
    expect(defaultV3InstallBody).not.toContain('ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT');
    expect(globalInstall).toContain('routecodex restart -c "$restart_config"');
    expect(globalInstall).not.toContain('routecodex restart --port "$restart_port"');
    expect(globalInstall).not.toContain('V3 install target missing current rccv3');
    expect(releaseInstall).not.toContain('V3 install target missing current rccv3');
    const installV3Cli = read('scripts/install-v3-cli.mjs');
    expect(installV3Cli).toContain("return path.join(resolveHomeDir(), '.local', 'bin')");
    expect(installV3Cli).toContain('path.join(resolveInstallBinDir(), binaryName)');
    expect(installV3Cli).not.toContain('ROUTECODEX_V3_INSTALL_BIN_DIR');
    expect(installV3Cli).not.toContain('RCC_V3_INSTALL_BIN_DIR');
    expect(installV3Cli).toContain("env.ROUTECODEX_BUILD_VERSION = readPackageVersion()");
    expect(globalInstall).toContain('local retired_install="$HOME/.rcc/install"');
    expect(globalInstall).toContain('rm -rf "$retired_install"');
    expect(v3ConfigSource).toContain('option_env!("ROUTECODEX_BUILD_VERSION")');
    expect(v3ConfigSource).toContain('ROUTECODEX_BUILD_VERSION must be embedded at compile time');
    expect(v3ConfigSource).not.toContain('std::env::var("ROUTECODEX_VERSION")');
    expect(v3ConfigSource).not.toContain('read_nearest_routecodex_package_version');
    expect(installV3Cli).not.toContain('V3 install target missing current rccv3');
    expect(installV3Cli).not.toContain("'install', 'current'");
    expect(installV3Cli).not.toContain('copyPackageJsonAtomic');
    expect(globalInstall).toContain('command -v rccv3');
    expect(globalInstall).toContain('command -v routecodex');
    expect(globalInstall).toContain('command -v rcc');
    expect(globalInstall).toContain('routecodex_version="$(routecodex --version)"');
    expect(globalInstall).toContain('rcc_version="$(rcc --version)"');
    expect(globalInstall).toContain('"$routecodex_version" != "$rccv3_version"');
    expect(globalInstall).toContain('rccv3 --help');
    expect(globalInstall).toContain('rcc --version');
    expect(releaseInstall).toContain('run_default_v3_release_install');
    expect(releaseInstall).toContain('node scripts/install-v3-cli.mjs');
    expect(releaseInstall).toContain('rcc restart -c "$VERIFY_CONFIG"');
    expect(releaseInstall).toContain('V3 release 验证缺少配置文件');
    expect(releaseInstall).toContain('command -v rccv3');
    expect(releaseInstall).toContain('command -v rcc');
    expect(releaseInstall).toContain('rccv3 --help');
    expect(releaseVerifier).toContain("extraBins: ['rcc', 'rccv3']");
    expect(releaseVerifier).toContain("run(extraBinPath, ['--help']");
    expect(globalInstall).toContain('默认 V3 产物：dist/bin/rccv3');
    expect(releaseInstall).toContain('默认 V3 产物 $INSTALL_BUILD_ROOT/dist/bin/rccv3');
    expect(globalInstall).toContain('V2 JS 兼容产物：dist/cli.js');
    expect(releaseInstall).toContain('V2 JS 兼容产物 $INSTALL_BUILD_ROOT/dist/cli.js');
    expect(globalInstall).toContain('INSTALL_V2_MODE');
    expect(releaseInstall).toContain('INSTALL_V2_MODE');
    expect(globalInstall).toContain('.gitignore .github AGENTS.md');
    expect(releaseInstall).toContain('.gitignore .github AGENTS.md');
    expect(globalInstall).not.toContain('command -v routecodex-v3');
    expect(releaseInstall).not.toContain('command -v routecodex-v3');
  });

  it('behaviorally locks direct command aliases to one binary without fallback', () => {
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
      expect(install.status).toBe(0);
      for (const commandName of ['routecodex', 'rcc', 'rccv3']) {
        const commandPath = path.join(shimDir, commandName);
        expect(fs.existsSync(commandPath)).toBe(true);
        expect(fs.realpathSync(commandPath)).toBe(fs.realpathSync(binaryPath));
        expect(crypto.createHash('sha256').update(fs.readFileSync(commandPath)).digest('hex'))
          .toBe(crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'));
        const result = spawnSync(commandPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('rccv3 ');
      }
      fs.unlinkSync(binaryPath);
      const missing = spawnSync(path.join(shimDir, 'routecodex'), ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(missing.status).not.toBe(0);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('rejects undeclared package/bin identities before mutating package metadata', () => {
    const packageBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const result = spawnSync(
      process.execPath,
      ['scripts/pack-mode.mjs', '--name', 'custom-rcc', '--bin', 'custom-rcc'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[pack-mode] unsupported release identity:');
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(fs.existsSync(path.join(root, 'package.json.bak.pack'))).toBe(false);
  });

  it('runs V3 install preflight gates and cargo build inside one isolated target dir', () => {
    expect(installV3Script).toContain('function buildV3CargoEnv(sourceEnv = process.env)');
    expect(installV3Script).toContain("fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-install-target-'))");
    expect(installV3Script).toContain('env.CARGO_TARGET_DIR = cargoTargetDir');
    expect(installV3Script).not.toContain("env.ROUTECODEX_SKIP_AUTO_BUMP = '1'");
    const envStart = installV3Script.indexOf('const { env, cargoTargetDir } = build;');
    const architectureGate = installV3Script.indexOf('V3 install resource-map gate');
    const semanticGate = installV3Script.indexOf('V3 CLI distribution gate');
    const buildVersionRefresh = installV3Script.indexOf(
      'env.ROUTECODEX_BUILD_VERSION = readPackageVersion();',
      installV3Script.indexOf('build-info/version generation'),
    );
    const cargoBuild = installV3Script.indexOf('cargo build for routecodex-v3-cli');
    expect(envStart).toBeGreaterThan(-1);
    expect(envStart).toBeLessThan(architectureGate);
    expect(envStart).toBeLessThan(semanticGate);
    expect(buildVersionRefresh).toBeGreaterThan(semanticGate);
    expect(buildVersionRefresh).toBeLessThan(cargoBuild);
    expect(envStart).toBeLessThan(cargoBuild);
  });
});
