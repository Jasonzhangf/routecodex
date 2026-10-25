#!/usr/bin/env node
// Behavioral regression for bug 8211850: the managed V3 Cargo test harness
// must hand the Cargo child an 8 MiB libtest stack default and must keep an
// explicit caller value untouched. The test runs the real wrapper executable
// and reads the environment that reaches a stubbed cargo child.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_V3_TEST_THREAD_STACK_BYTES = '8388608';
const v3Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wrapperPath = join(v3Root, 'scripts', 'run-v3-cargo-test.mjs');
const fixtureTargetDir = join(v3Root, 'target', 'stack-env-regression');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'routecodex-v3-stack-env-'));
const fixtureBin = join(fixtureRoot, 'bin');
const childEnvLogPath = join(fixtureRoot, 'cargo-child-env.jsonl');

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function stubCargo() {
  writeExecutable(join(fixtureBin, 'cargo'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(childEnvLogPath)}, JSON.stringify({
  args: process.argv.slice(2),
  rustMinStack: process.env.RUST_MIN_STACK === undefined ? null : process.env.RUST_MIN_STACK,
}) + '\\n');
`);
}

function readCargoChildEnvironments() {
  if (!existsSync(childEnvLogPath)) return [];
  return readFileSync(childEnvLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runWrapper({ rustMinStack } = {}) {
  if (existsSync(childEnvLogPath)) rmSync(childEnvLogPath);
  const env = {
    ...process.env,
    PATH: `${fixtureBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    CARGO_TARGET_DIR: fixtureTargetDir,
  };
  if (rustMinStack === undefined) delete env.RUST_MIN_STACK;
  else env.RUST_MIN_STACK = rustMinStack;
  const result = spawnSync(
    process.execPath,
    [wrapperPath, '--workspace', '--', '--nocapture'],
    { encoding: 'utf8', timeout: 120000, env },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    cargoChildren: readCargoChildEnvironments(),
  };
}

try {
  mkdirSync(fixtureBin, { recursive: true });
  stubCargo();

  const unsetResult = runWrapper();
  assert.equal(
    unsetResult.status,
    0,
    `default-stack-run: wrapper must succeed (stderr: ${unsetResult.stderr}, error: ${unsetResult.error})`,
  );
  assert.equal(unsetResult.cargoChildren.length, 1, 'default-stack-run: exactly one Cargo child must run');
  assert.ok(unsetResult.cargoChildren[0].args.includes('test'), 'default-stack-run: the child must be a Cargo test run');
  assert.equal(
    unsetResult.cargoChildren[0].rustMinStack,
    DEFAULT_V3_TEST_THREAD_STACK_BYTES,
    'default-stack-run: an unset RUST_MIN_STACK must reach the Cargo child as exactly 8388608',
  );

  const explicitResult = runWrapper({ rustMinStack: '1048576' });
  assert.equal(
    explicitResult.status,
    0,
    `explicit-stack-run: wrapper must succeed (stderr: ${explicitResult.stderr}, error: ${explicitResult.error})`,
  );
  assert.equal(explicitResult.cargoChildren.length, 1, 'explicit-stack-run: exactly one Cargo child must run');
  assert.equal(
    explicitResult.cargoChildren[0].rustMinStack,
    '1048576',
    'explicit-stack-run: an explicit RUST_MIN_STACK must win over the harness default',
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(fixtureTargetDir, { recursive: true, force: true });
}

process.stdout.write('[test:v3-cargo-test-stack-env-regression] PASS\n');
