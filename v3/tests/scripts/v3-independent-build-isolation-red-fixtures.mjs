#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  v3Root,
  collectIsolationFailures,
  pinnedRustToolchain,
} from '../../scripts/verify-isolation.mjs';

const completeFiles = new Set([
  'package.json',
  'package-lock.json',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo/config.toml',
]);
const validPackage = JSON.stringify({
  scripts: {
    build: 'node scripts/build.mjs',
    verify: 'node scripts/verify-isolation.mjs',
  },
});
const noCargoFailures = () => [];
const localYaml = () => `${v3Root}/node_modules/yaml/dist/index.js`;
const validRead = (path) => path === 'rust-toolchain.toml'
  ? `[toolchain]\nchannel = "${pinnedRustToolchain}"\n`
  : validPackage;

const valid = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: localYaml,
});
assert.deepEqual(valid, []);

for (const missing of ['package.json', 'package-lock.json', 'rust-toolchain.toml', '.cargo/config.toml']) {
  const failures = collectIsolationFailures({
    env: {},
    fileExists: (path) => path !== missing && completeFiles.has(path),
    read: validRead,
    inspectCargo: noCargoFailures,
    resolveNodeDependency: localYaml,
  });
  assert(failures.some((failure) => failure.includes(missing)), `missing ${missing} must fail`);
}

const externalTarget = collectIsolationFailures({
  env: { CARGO_TARGET_DIR: '/tmp/routecodex-v3-target' },
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: localYaml,
});
assert(externalTarget.some((failure) => failure.includes('external CARGO_TARGET_DIR')));

for (const rootInput of ['../scripts/', '../package.json', '../dist', '../artifacts', '../src/build-info']) {
  const failures = collectIsolationFailures({
    env: {},
    fileExists: (path) => completeFiles.has(path),
    read: (path) => path === 'rust-toolchain.toml'
      ? `[toolchain]\nchannel = "${pinnedRustToolchain}"\n`
      : JSON.stringify({ scripts: { verify: `node ${rootInput}` } }),
    inspectCargo: noCargoFailures,
    resolveNodeDependency: localYaml,
  });
  assert(failures.some((failure) => failure.includes(rootInput)), `${rootInput} must fail`);
}

const escapingCargo = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: () => ['routecodex-v3-runtime dependency servertool-core escapes V3'],
  resolveNodeDependency: localYaml,
});
assert(escapingCargo.some((failure) => failure.includes('escapes V3')));

const rootNodeModulesFallback = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: () => '/repo/node_modules/yaml/dist/index.js',
});
assert(rootNodeModulesFallback.some((failure) => failure.includes('outside v3/node_modules')));

const missingLocalDependency = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: () => {
    throw new Error('module not found');
  },
});
assert(missingLocalDependency.some((failure) => failure.includes('unavailable locally')));

const floatingToolchain = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: (path) => path === 'rust-toolchain.toml' ? '[toolchain]\nchannel = "stable"\n' : validPackage,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: localYaml,
});
assert(floatingToolchain.some((failure) => failure.includes(`pin ${pinnedRustToolchain}`)));

const externalToolchain = collectIsolationFailures({
  env: { RUSTUP_TOOLCHAIN: 'stable' },
  fileExists: (path) => completeFiles.has(path),
  read: validRead,
  inspectCargo: noCargoFailures,
  resolveNodeDependency: localYaml,
});
assert(externalToolchain.some((failure) => failure.includes('external RUSTUP_TOOLCHAIN')));

const scriptToolchainOverride = collectIsolationFailures({
  env: {},
  fileExists: (path) => completeFiles.has(path),
  read: (path) => path === 'rust-toolchain.toml'
    ? `[toolchain]\nchannel = "${pinnedRustToolchain}"\n`
    : JSON.stringify({ scripts: { test: 'cargo +stable test' } }),
  inspectCargo: noCargoFailures,
  resolveNodeDependency: localYaml,
});
assert(scriptToolchainOverride.some((failure) => failure.includes('explicit toolchain override')));

process.stdout.write('[test:v3-independent-build-isolation-red-fixtures] PASS\n');
