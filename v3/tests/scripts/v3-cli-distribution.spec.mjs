import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(v3Root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const cargo = read('crates/routecodex-v3-cli/Cargo.toml');
const copyScript = read('scripts/copy-cli-bin.mjs');
const installScript = read('scripts/install-cli.mjs');
const packScript = read('scripts/pack-release.mjs');

test('V3 owns one local binary and command alias contract', () => {
  assert.deepEqual(packageJson.bin, {
    routecodex: 'dist/bin/rccv3',
    rcc: 'dist/bin/rccv3',
    rccv3: 'dist/bin/rccv3',
  });
  assert.ok(cargo.includes('name = "rccv3"'));
  assert.match(copyScript, /'--locked',[\s\S]*'--release'/);
  assert.ok(copyScript.includes("path.join(v3Root, 'target', 'release'"));
  assert.ok(copyScript.includes("path.join(v3Root, 'dist', 'bin'"));
});

test('install builds release inside V3 and atomically publishes one direct binary', () => {
  assert.ok(installScript.includes("path.join(v3Root, 'build-control', 'install-target'"));
  assert.match(installScript, /runInterruptibleCommand\('cargo', \[[\s\S]*'--locked',[\s\S]*'--release'/);
  assert.ok(installScript.includes("path.join(cargoTargetDir, 'release', binaryName)"));
  assert.ok(installScript.includes('copyExecutableAtomic(sourceBin, repoBin)'));
  assert.ok(installScript.includes('copyExecutableAtomic(repoBin, installBin, { sign: false })'));
  assert.ok(installScript.includes("for (const alias of ['routecodex', 'rcc'])"));
  assert.ok(installScript.includes('fs.symlinkSync(path.basename(binaryPath), temporaryPath)'));
  assert.ok(installScript.includes("codesign', ['-s', '-', '-f'"));
  assert.equal(installScript.includes('fs.rmSync(aliasPath, { force: true })'), false);
  for (const forbidden of ['../package.json', '../src/build-info', "'install', 'current'", 'os.tmpdir()']) {
    assert.equal(installScript.includes(forbidden), false, `install must not contain ${forbidden}`);
  }
});

test('pack owns V3-local release target, staging, dist, and final artifacts', () => {
  assert.ok(packScript.includes("path.join(v3Root, 'build-control', 'pack')"));
  assert.ok(packScript.includes("path.join(v3Root, 'artifacts', 'pack')"));
  assert.ok(packScript.includes("path.join(v3Root, 'dist', 'bin'"));
  assert.ok(packScript.includes("'--locked',\n    '--release'"));
  assert.ok(packScript.includes("CARGO_TARGET_DIR: cargoTarget"));
  assert.ok(packScript.includes("fs.rmSync(runRoot, { recursive: true, force: true })"));
  assert.ok(packScript.includes("'--pack-destination', npmOutput"));
  assert.ok(packScript.includes("routecodex: 'dist/bin/rccv3'"));
  assert.ok(packScript.includes("rcc: 'dist/bin/rccv3'"));
  assert.ok(packScript.includes("rccv3: 'dist/bin/rccv3'"));
  assert.equal(packScript.includes('os.tmpdir()'), false);
  assert.equal(packScript.includes("path.join(repoRoot, 'dist'"), false);
  assert.equal(packScript.includes("path.join(repoRoot, 'artifacts'"), false);
});

test('unsupported pack mode fails before creating V3 staging or mutating version truth', () => {
  const packageBefore = read('package.json');
  const buildControl = path.join(v3Root, 'build-control', 'pack');
  const entriesBefore = fs.existsSync(buildControl) ? fs.readdirSync(buildControl).sort() : [];
  const result = spawnSync(process.execPath, ['scripts/pack-release.mjs', '--mode', 'invalid'], {
    cwd: v3Root,
    encoding: 'utf8',
  });
  const entriesAfter = fs.existsSync(buildControl) ? fs.readdirSync(buildControl).sort() : [];
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[pack-release\] unknown mode:/);
  assert.equal(read('package.json'), packageBefore);
  assert.deepEqual(entriesAfter, entriesBefore);
});
