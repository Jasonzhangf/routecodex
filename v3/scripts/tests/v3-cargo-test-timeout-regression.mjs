#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'scripts', 'run-v3-cargo-test.mjs'), 'utf8');
const { executeCargo, isUnreapedProcessGroupError } = await import('../run-v3-cargo-test.mjs');
const CLEANUP_FAILURE_EXIT = 86;

function writeTimeoutFixture({ artifactPath = null } = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'routecodex-v3-cargo-timeout-'));
  const cargoPath = join(fixtureDir, 'cargo.cjs');
  writeFileSync(join(fixtureDir, 'descendant.cjs'), [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const artifactJson = artifactPath
    ? JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable: artifactPath })
    : null;
  writeFileSync(cargoPath, [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    ...(artifactJson ? [`process.stdout.write(${JSON.stringify(`${artifactJson}\n`)});`] : []),
    "const descendant = spawn(process.execPath, [join(__dirname, 'descendant.cjs')], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "writeFileSync(join(__dirname, 'pids.json'), JSON.stringify({ cargoPid: process.pid, descendantPid: descendant.pid }));",
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  chmodSync(cargoPath, 0o755);
  return { fixtureDir, cargoPath, pidsPath: join(fixtureDir, 'pids.json') };
}

function writeCargoExitsEarlyFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'routecodex-v3-cargo-early-exit-'));
  const cargoPath = join(fixtureDir, 'cargo.cjs');
  writeFileSync(join(fixtureDir, 'descendant.cjs'), [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  writeFileSync(cargoPath, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const descendant = spawn(process.execPath, [join(__dirname, 'descendant.cjs')], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "writeFileSync(join(__dirname, 'pids.json'), JSON.stringify({ cargoPid: process.pid, descendantPid: descendant.pid }));",
    'setTimeout(() => process.exit(0), 50);',
    '',
  ].join('\n'));
  return { fixtureDir, cargoPath, pidsPath: join(fixtureDir, 'pids.json') };
}

function writeCargoExitsOnSigtermFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'routecodex-v3-cargo-sigterm-exit-'));
  const cargoPath = join(fixtureDir, 'cargo.cjs');
  writeFileSync(join(fixtureDir, 'descendant.cjs'), [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  writeFileSync(cargoPath, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const descendant = spawn(process.execPath, [join(__dirname, 'descendant.cjs')], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "writeFileSync(join(__dirname, 'pids.json'), JSON.stringify({ cargoPid: process.pid, descendantPid: descendant.pid }));",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  return { fixtureDir, cargoPath, pidsPath: join(fixtureDir, 'pids.json') };
}

function killFixtureProcesses(pidsPath) {
  let record;
  try {
    record = JSON.parse(readFileSync(pidsPath, 'utf8'));
  } catch {
    return;
  }
  for (const pid of [record.cargoPid, record.descendantPid]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    throw error;
  }
}

async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function assertDescendantHoldingStdoutIsBounded() {
  const { fixtureDir, cargoPath, pidsPath } = writeTimeoutFixture();
  const hardBoundMs = 5000;
  let hardBoundTimer;
  try {
    const outcome = await Promise.race([
      executeCargo([cargoPath, 'test'], new Set(), {
        command: process.execPath,
        timeoutMs: 300,
        killGraceMs: 150,
      }).then(
        (code) => ({ type: 'resolved', code }),
        (error) => ({ type: 'rejected', error }),
      ),
      new Promise((resolve) => {
        hardBoundTimer = setTimeout(() => resolve({ type: 'hung' }), hardBoundMs);
      }),
    ]);
    assert.equal(
      outcome.type,
      'rejected',
      `a descendant holding the inherited stdout pipe must not keep executeCargo pending; observed ${outcome.type} after ${hardBoundMs}ms`,
    );
    assert.match(
      outcome.error.message,
      /cargo test timed out after 300ms and was terminated/u,
      'timeout rejection must carry the cargo timeout diagnostic',
    );
  } finally {
    if (hardBoundTimer) clearTimeout(hardBoundTimer);
    killFixtureProcesses(pidsPath);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function assertEarlyCargoExitStillReapsGroupAndSettles() {
  const { fixtureDir, cargoPath, pidsPath } = writeCargoExitsEarlyFixture();
  const hardBoundMs = 5000;
  let hardBoundTimer;
  try {
    const outcome = await Promise.race([
      executeCargo([cargoPath, 'test'], new Set(), {
        command: process.execPath,
        timeoutMs: 300,
        killGraceMs: 150,
      }).then(
        (code) => ({ type: 'resolved', code }),
        (error) => ({ type: 'rejected', error }),
      ),
      new Promise((resolve) => {
        hardBoundTimer = setTimeout(() => resolve({ type: 'hung' }), hardBoundMs);
      }),
    ]);
    assert.equal(
      outcome.type,
      'rejected',
      `cargo exiting early while a descendant holds the inherited stdout must still settle; observed ${outcome.type} after ${hardBoundMs}ms`,
    );
    assert.match(
      outcome.error.message,
      /cargo test timed out after 300ms and was terminated/u,
      'early-cargo-exit timeout rejection must carry the cargo timeout diagnostic',
    );
    const record = JSON.parse(readFileSync(pidsPath, 'utf8'));
    assert.equal(
      Number.isInteger(record.descendantPid) && record.descendantPid > 0,
      true,
      'fixture must record the descendant pid',
    );
    assert.equal(
      await waitForProcessGone(record.descendantPid, 1000),
      true,
      'the descendant must be reaped through the cargo process-group kill within 1000ms',
    );
  } finally {
    if (hardBoundTimer) clearTimeout(hardBoundTimer);
    killFixtureProcesses(pidsPath);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function assertCargoExitOnSigtermWaitsForGroupKillBeforeSettling() {
  const { fixtureDir, cargoPath, pidsPath } = writeCargoExitsOnSigtermFixture();
  const hardBoundMs = 5000;
  let hardBoundTimer;
  try {
    const outcome = await Promise.race([
      executeCargo([cargoPath, 'test'], new Set(), {
        command: process.execPath,
        timeoutMs: 300,
        killGraceMs: 150,
      }).then(
        (code) => ({ type: 'resolved', code }),
        (error) => ({ type: 'rejected', error }),
      ),
      new Promise((resolve) => {
        hardBoundTimer = setTimeout(() => resolve({ type: 'hung' }), hardBoundMs);
      }),
    ]);
    assert.equal(
      outcome.type,
      'rejected',
      `cargo exiting on SIGTERM while a descendant ignores SIGTERM must still time out; observed ${outcome.type}`,
    );
    assert.match(
      outcome.error.message,
      /cargo test timed out after 300ms and was terminated/u,
      'SIGTERM cargo exit must not bypass the timeout rejection',
    );
    const record = JSON.parse(readFileSync(pidsPath, 'utf8'));
    assert.equal(
      Number.isInteger(record.descendantPid) && record.descendantPid > 0,
      true,
      'fixture must record the descendant pid',
    );
    assert.equal(
      processGone(record.cargoPid),
      true,
      'cargo must already be reaped when executeCargo settles',
    );
    assert.equal(
      processGone(record.descendantPid),
      true,
      'executeCargo must not settle before the process-group SIGKILL reaps the descendant',
    );
  } finally {
    if (hardBoundTimer) clearTimeout(hardBoundTimer);
    killFixtureProcesses(pidsPath);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function assertUnusableProbeIsAControlledFailure({ probeCommand, expectedDetail, label }) {
  const { fixtureDir, cargoPath, pidsPath } = writeTimeoutFixture();
  const hardBoundMs = 5000;
  let hardBoundTimer;
  const rejections = [];
  const recordRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', recordRejection);
  try {
    const outcome = await Promise.race([
      executeCargo([cargoPath, 'test'], new Set(), {
        command: process.execPath,
        timeoutMs: 300,
        killGraceMs: 150,
        probeCommand,
      }).then(
        (code) => ({ type: 'resolved', code }),
        (error) => ({ type: 'rejected', error }),
      ),
      new Promise((resolve) => {
        hardBoundTimer = setTimeout(() => resolve({ type: 'hung' }), hardBoundMs);
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      outcome.type,
      'rejected',
      `${label}: an unusable group probe must settle the timeout as a controlled failure; observed ${outcome.type} after ${hardBoundMs}ms`,
    );
    assert.equal(
      isUnreapedProcessGroupError(outcome.error),
      true,
      `${label}: an unusable group probe must produce the typed unreaped-group failure`,
    );
    assert.match(outcome.error.message, expectedDetail);
    assert.deepEqual(
      rejections.map((reason) => String(reason?.message ?? reason)),
      [],
      `${label}: the cleanup callback must not leak an unhandled rejection`,
    );
  } finally {
    if (hardBoundTimer) clearTimeout(hardBoundTimer);
    process.off('unhandledRejection', recordRejection);
    killFixtureProcesses(pidsPath);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function startCargoTestDriver(probeExpression) {
  const targetRoot = join(
    root,
    'target',
    `timeout-retention-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  const debugDeps = join(targetRoot, 'debug', 'deps');
  mkdirSync(debugDeps, { recursive: true });
  const fakeExecutable = join(debugDeps, 'routecodex-v3-fake-timeout-bin');
  const fakeObject = join(debugDeps, 'routecodex-v3-fake-timeout-bin.abc.rcgu.o');
  writeFileSync(fakeExecutable, 'fake executable\n');
  writeFileSync(fakeObject, 'fake object\n');
  const { fixtureDir, cargoPath, pidsPath } = writeTimeoutFixture({ artifactPath: fakeExecutable });
  const driverPath = join(fixtureDir, 'driver.mjs');
  writeFileSync(driverPath, [
    `import { executeCargo, runV3CargoTest } from ${JSON.stringify(join(root, 'scripts', 'run-v3-cargo-test.mjs'))};`,
    'const unhandled = [];',
    "process.on('unhandledRejection', (reason) => unhandled.push(reason));",
    `const execute = (args, executables) => executeCargo([${JSON.stringify(cargoPath)}, 'test'], executables, {`,
    '  command: process.execPath,',
    '  timeoutMs: 300,',
    '  killGraceMs: 200,',
    `  probeCommand: ${probeExpression},`,
    '});',
    'const code = await runV3CargoTest([], { execute });',
    'await new Promise((resolve) => setTimeout(resolve, 100));',
    "if (unhandled.length > 0) { console.error('[driver] unhandled rejections: ' + unhandled.length); process.exit(97); }",
    'process.exit(code);',
    '',
  ].join('\n'));
  const driver = spawnSync(process.execPath, [driverPath], {
    encoding: 'utf8',
    env: { ...process.env, CARGO_TARGET_DIR: relative(root, targetRoot) },
    timeout: 30000,
  });
  return {
    driver,
    fixtureDir,
    pidsPath,
    targetRoot,
    fakeExecutable,
    fakeObject,
    lockDir: join(targetRoot, '.routecodex-v3-test.lock'),
  };
}

function closeCargoTestDriver(state) {
  killFixtureProcesses(state.pidsPath);
  rmSync(state.fixtureDir, { recursive: true, force: true });
  rmSync(state.targetRoot, { recursive: true, force: true });
}

async function assertCleanupOnlyRunsAfterConfirmedReap() {
  const retained = startCargoTestDriver("() => ({ status: 0, stdout: '', stderr: '' })");
  try {
    assert.equal(retained.driver.error, undefined, `driver must not hang: ${retained.driver.error?.message ?? ''}`);
    assert.equal(
      retained.driver.status,
      CLEANUP_FAILURE_EXIT,
      `a group still reported alive at the grace deadline must fail the wrapper; stderr:\n${retained.driver.stderr}`,
    );
    assert.match(retained.driver.stderr, /process group not confirmed stopped; retaining test lock and artifacts/u);
    assert.match(
      retained.driver.stderr,
      /was not confirmed stopped \(process group still has live members after the 200ms kill grace\)/u,
    );
    assert.doesNotMatch(
      retained.driver.stdout,
      /debug allocation after cleanup/u,
      'artifact cleanup must not run while the group is not confirmed stopped',
    );
    assert.equal(existsSync(retained.fakeExecutable), true, 'test executables must be retained');
    assert.equal(existsSync(retained.fakeObject), true, 'compiled test objects must be retained');
    assert.equal(existsSync(retained.lockDir), true, 'the canonical test lock must be retained');
  } finally {
    closeCargoTestDriver(retained);
  }

  const reaped = startCargoTestDriver("() => ({ status: 1, stdout: '', stderr: '' })");
  try {
    assert.equal(reaped.driver.error, undefined, `driver must not hang: ${reaped.driver.error?.message ?? ''}`);
    assert.equal(
      reaped.driver.status,
      CLEANUP_FAILURE_EXIT,
      `a confirmed-reaped group must still report the timeout failure; stderr:\n${reaped.driver.stderr}`,
    );
    assert.match(
      reaped.driver.stderr,
      /cargo test timed out after 300ms and was terminated/u,
      'the confirmed-reaped path must keep the plain timeout diagnostic',
    );
    assert.match(
      reaped.driver.stdout,
      /debug allocation after cleanup/u,
      'the confirmed-reaped path must run artifact cleanup',
    );
    assert.equal(existsSync(reaped.fakeExecutable), false, 'confirmed reap must release the test executable');
    assert.equal(existsSync(reaped.fakeObject), false, 'confirmed reap must release compiled test objects');
    assert.equal(existsSync(reaped.lockDir), false, 'confirmed reap must release the canonical test lock');
  } finally {
    closeCargoTestDriver(reaped);
  }
}

await assertDescendantHoldingStdoutIsBounded();
await assertEarlyCargoExitStillReapsGroupAndSettles();
await assertCargoExitOnSigtermWaitsForGroupKillBeforeSettling();
await assertUnusableProbeIsAControlledFailure({
  probeCommand: () => ({ error: Object.assign(new Error('spawn pgrep EACCES'), { code: 'EACCES' }) }),
  expectedDetail: /process-group probe failed: spawn pgrep EACCES/u,
  label: 'pgrep spawn failure',
});
await assertUnusableProbeIsAControlledFailure({
  probeCommand: () => ({ status: 2, stdout: '', stderr: 'usage: pgrep' }),
  expectedDetail: /process-group probe failed: pgrep -g \d+ failed with status 2/u,
  label: 'pgrep non-0/1 status',
});
await assertCleanupOnlyRunsAfterConfirmedReap();

assert.match(source, /CARGO_TEST_TIMEOUT_MS\s*=\s*40\s*\*\s*60\s*\*\s*1000/u);
assert.match(source, /detached:\s*true/u);
assert.match(source, /process\.kill\(-child\.pid, 'SIGTERM'\)/u);
assert.match(source, /process\.kill\(-child\.pid, 'SIGKILL'\)/u);
assert.match(source, /cargo timeout \$\{timeoutMs\}ms; sending SIGTERM to process group/u);
assert.match(source, /grace expired; sending SIGKILL to process group/u);
assert.match(source, /cargo test timed out after \$\{timeoutMs\}ms/u);
assert.match(source, /clearTimeout\(timeoutTimer\)/u);
assert.match(source, /child\.on\('close', finish\)/u);
assert.match(source, /child\.on\('exit',[\s\S]*?timedOut[\s\S]*?\}\);/u);
assert.match(source, /child\.stdout\.destroy\(\)/u);
assert.match(source, /isUnreapedProcessGroupError\(terminalError\)/u);
assert.match(source, /retaining test lock and artifacts/u);
assert.match(source, /probeCommand = defaultProbeCommand/u);

process.stdout.write('[test:v3-cargo-test-timeout-regression] PASS\n');
