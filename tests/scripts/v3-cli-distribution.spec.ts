import fs from 'node:fs';
import path from 'node:path';

describe('V3 CLI distribution surface', () => {
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

  it('publishes only the rccv3 command and artifact', () => {
    expect(packageJson.bin).toEqual({
      routecodex: 'dist/cli.js',
      rccv3: 'dist/bin/rccv3',
    });
    expect(cargo).toContain('name = "rccv3"');
    expect(copyScript).toContain("process.platform === 'win32' ? 'rccv3.exe' : 'rccv3'");
    expect(copyScript).toContain("path.join(root, 'dist', 'bin'");
    expect(copyScript).toContain('legacyTargetBin');
    expect(copyScript).toContain('fs.rmSync(legacyTargetBin, { force: true })');
    expect(packScript).toContain("mutated.bin.rccv3 = 'dist/bin/rccv3'");
    expect(packScript).not.toContain("mutated.bin['routecodex-v3']");
  });

  it('installs, shims, and verifies rccv3 globally', () => {
    expect(shimScript).toContain("writeShim(shimDir, 'rccv3', 'routecodex'");
    expect(shimScript).toContain("path.join('dist', 'bin', 'rccv3')");
    expect(shimScript).toContain("removeLegacyShim(shimDir, 'routecodex-v3')");
    expect(shimScript).toContain('removeExistingShimPath(shimPath)');
    expect(shimScript).toContain('fs.lstatSync(shimPath)');
    expect(shimScript).toContain('fs.rmSync(shimPath, { force: true })');
    expect(executableScript).toContain("path.join(process.cwd(), 'dist', 'bin', 'rccv3')");
    expect(executableScript).toContain("ensureGlobalBinTarget('rccv3')");
    expect(globalInstall).toContain('$NPM_PREFIX/bin/rccv3');
    expect(globalInstall).toContain('command -v rccv3');
    expect(globalInstall).toContain('rccv3 --help');
    expect(releaseInstall).toContain('command -v rccv3');
    expect(releaseInstall).toContain('rccv3 --help');
    expect(releaseVerifier).toContain("extraBins: ['rccv3']");
    expect(releaseVerifier).toContain("run(extraBinPath, ['--help']");
    expect(globalInstall).not.toContain('command -v routecodex-v3');
    expect(releaseInstall).not.toContain('command -v routecodex-v3');
  });
});
