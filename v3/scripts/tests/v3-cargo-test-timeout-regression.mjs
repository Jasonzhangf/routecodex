#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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

const signalErrorPrelude = [
  '  const realKill = process.kill.bind(process);',
  '  process.kill = (pid, signal) => {',
  "    if (typeof pid === 'number' && pid < 0) {",
  "      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });",
  '    }',
  '    return realKill(pid, signal);',
  '  };',
].join('\n');

function writeTimeoutFixture({ artifactPath = null, descendantStdio = ['ignore', 'inherit', 'inherit'], exitAfterMs = null } = {}) {
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
  const descendantIo = String(JSON.stringify(descendantStdio));
  writeFileSync(cargoPath, [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    ...(artifactJson ? [`process.stdout.write(${JSON.stringify(`${artifactJson}\n`)});`] : []),
    `const descendant = spawn(process.execPath, [join(__dirname, 'descendant.cjs')], { stdio: ${descendantIo} });`,
    "writeFileSync(join(__dirname, 'pids.json'), JSON.stringify({ cargoPid: process.pid, descendantPid: descendant.pid }));",
    "process.on('SIGTERM', () => {});",
    ...(exitAfterMs ? [`setTimeout(() => process.exit(0), ${exitAfterMs});`] : []),
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

function startCargoTestDriver(probeExpression, {
  targetRoot: sharedTargetRoot = null,
  prepareArtifacts = true,
  executePrelude = null,
  descendantStdio = ['ignore', 'inherit', 'inherit'],
  exitAfterMs = null,
  driverExitCleanup = null,
  naturalExit = false,
  captureToFiles = false,
} = {}) {
  const targetRoot = sharedTargetRoot ?? join(
    root,
    'target',
    `timeout-retention-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  const debugDeps = join(targetRoot, 'debug', 'deps');
  mkdirSync(debugDeps, { recursive: true });
  const fakeExecutable = join(debugDeps, 'routecodex-v3-fake-timeout-bin');
  const fakeObject = join(debugDeps, 'routecodex-v3-fake-timeout-bin.abc.rcgu.o');
  if (prepareArtifacts) {
    writeFileSync(fakeExecutable, 'fake executable\n');
    writeFileSync(fakeObject, 'fake object\n');
  }
  const { fixtureDir, cargoPath, pidsPath } = writeTimeoutFixture({
    artifactPath: fakeExecutable,
    descendantStdio,
    exitAfterMs,
  });
  const driverPath = join(fixtureDir, 'driver.mjs');
  writeFileSync(driverPath, [
    `import { chmodSync } from 'node:fs';`,
    `import { executeCargo, runV3CargoTest } from ${JSON.stringify(join(root, 'scripts', 'run-v3-cargo-test.mjs'))};`,
    `const fixturePidsPath = ${JSON.stringify(pidsPath)};`,
    'const unhandled = [];',
    "process.on('unhandledRejection', (reason) => unhandled.push(reason));",
    `const probeCommand = ${probeExpression};`,
    'const execute = async (args, executables) => {',
    ...(executePrelude ? [`  ${executePrelude}`] : []),
    `  return executeCargo([${JSON.stringify(cargoPath)}, 'test'], executables, {`,
    '    command: process.execPath,',
    '    timeoutMs: 300,',
    '    killGraceMs: 200,',
    '    probeCommand,',
    '  });',
    '};',
    'const code = await runV3CargoTest([], { execute, probeCommand });',
    'await new Promise((resolve) => setTimeout(resolve, 100));',
    ...(driverExitCleanup ? [driverExitCleanup] : []),
    "if (unhandled.length > 0) { console.error('[driver] unhandled rejections: ' + unhandled.length); process.exit(97); }",
    naturalExit ? 'process.exitCode = code;' : 'process.exit(code);',
    '',
  ].join('\n'));
  const env = { ...process.env, CARGO_TARGET_DIR: relative(root, targetRoot) };
  let driver;
  if (captureToFiles) {
    // A surviving fixture inherits the driver's stdout/stderr, so a piped
    // spawnSync would wait on a pipe only that fixture can close. Capture to
    // files so the wait is bound to the driver process exit itself.
    const stdoutPath = join(fixtureDir, 'driver.stdout.log');
    const stderrPath = join(fixtureDir, 'driver.stderr.log');
    const outFd = openSync(stdoutPath, 'w');
    const errFd = openSync(stderrPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [driverPath], {
        env,
        timeout: 30000,
        stdio: ['ignore', outFd, errFd],
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    driver = {
      ...result,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } else {
    driver = spawnSync(process.execPath, [driverPath], { encoding: 'utf8', env, timeout: 30000 });
  }
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

function closeCargoTestDriver(state, { keepTarget = false } = {}) {
  killFixtureProcesses(state.pidsPath);
  rmSync(state.fixtureDir, { recursive: true, force: true });
  if (!keepTarget) rmSync(state.targetRoot, { recursive: true, force: true });
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

// Two successive public-wrapper calls on the same target. The first leaves an
// unreaped process group behind and persists that identity as the lock owner.
// The second call must not let the dead wrapper PID reclaim the target until the
// persisted group is confirmed gone: while the probe still reports a live member
// the second call is blocked (86) and the artifacts/lock stay; only a `gone`
// probe lets it recover and run cleanup.
async function assertUnreapedLockSurvivesDeadWrapperPid() {
  const first = startCargoTestDriver("() => ({ status: 0, stdout: '', stderr: '' })");
  try {
    assert.equal(first.driver.error, undefined, `first driver must not hang: ${first.driver.error?.message ?? ''}`);
    assert.equal(
      first.driver.status,
      CLEANUP_FAILURE_EXIT,
      `first call must fail closed with artifacts retained; stderr:\n${first.driver.stderr}`,
    );
    assert.match(first.driver.stderr, /process group not confirmed stopped; retaining test lock and artifacts/u);
    assert.equal(existsSync(first.lockDir), true, 'the unreaped-group lock must be present after the first call');
    const ownerJson = readFileSync(join(first.lockDir, 'owner.json'), 'utf8');
    const owner = JSON.parse(ownerJson);
    assert.equal(
      Boolean(owner?.unreapedProcessGroup?.processGroupId),
      true,
      `first call must persist the unreaped process group identity; owner:\n${ownerJson}`,
    );
    assert.equal(
      existsSync(first.fakeExecutable),
      true,
      'first call must retain the test executable for the second call to find',
    );
    assert.equal(existsSync(first.fakeObject), true, 'first call must retain the compiled test object');

    const stillAlive = startCargoTestDriver("() => ({ status: 0, stdout: '', stderr: '' })", {
      targetRoot: first.targetRoot,
      prepareArtifacts: false,
    });
    try {
      assert.equal(
        stillAlive.driver.error,
        undefined,
        `second call must not hang while the group is unreaped; ${stillAlive.driver.error?.message ?? ''}`,
      );
      assert.equal(
        stillAlive.driver.status,
        CLEANUP_FAILURE_EXIT,
        `second call must be blocked by the unreaped-group lock; stderr:\n${stillAlive.driver.stderr}`,
      );
      assert.match(
        stillAlive.driver.stderr,
        /unreaped process group \d+ still has live members/u,
        'second call must refuse to reuse the target while the group is unreaped',
      );
      assert.equal(existsSync(stillAlive.fakeExecutable), true, 'blocked second call must not delete the retained executable');
      assert.equal(existsSync(stillAlive.fakeObject), true, 'blocked second call must not delete the retained object');
      assert.equal(existsSync(stillAlive.lockDir), true, 'blocked second call must not release the lock');
    } finally {
      closeCargoTestDriver(stillAlive, { keepTarget: true });
    }

    // Once the persisted group is confirmed gone the next caller may reclaim
    // the lock, own the target, and run its cleanup.
    const recovered = startCargoTestDriver("() => ({ status: 1, stdout: '', stderr: '' })", {
      targetRoot: first.targetRoot,
      prepareArtifacts: false,
    });
    try {
      assert.equal(
        recovered.driver.error,
        undefined,
        `recovery driver must not hang: ${recovered.driver.error?.message ?? ''}`,
      );
      assert.equal(
        recovered.driver.status,
        CLEANUP_FAILURE_EXIT,
        `recovery call must fail the timeout but reclaim the lock; stderr:\n${recovered.driver.stderr}`,
      );
      assert.match(
        recovered.driver.stderr,
        /cargo test timed out after 300ms and was terminated/u,
        'recovery call must keep the plain timeout diagnostic',
      );
      assert.match(
        recovered.driver.stdout,
        /debug allocation after cleanup/u,
        'recovery call must run artifact cleanup once the group is confirmed gone',
      );
      assert.equal(existsSync(recovered.fakeExecutable), false, 'recovery call must release the test executable');
      assert.equal(existsSync(recovered.fakeObject), false, 'recovery call must release the compiled test object');
      assert.equal(existsSync(recovered.lockDir), false, 'recovery call must release the canonical test lock');
    } finally {
      closeCargoTestDriver(recovered, { keepTarget: true });
    }
  } finally {
    closeCargoTestDriver(first);
  }
}

// The unreaped-group terminal state must survive an owner write failure. The
// lock execution marker is created before the owner was ever written, so a
// subsequent wrapper call can neither parse a stale owner nor let the stale
// grace timeout authorize reuse: it must keep returning 86, keep the lock and
// old artifacts, and never run Cargo.
async function assertOwnerWriteFailureStillBlocksNextCall() {
  const targetRoot = join(
    root,
    'target',
    `timeout-retention-owner-failure-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  const state = startCargoTestDriver("() => ({ status: 0, stdout: '', stderr: '' })", {
    targetRoot,
    prepareArtifacts: true,
    executePrelude: `chmodSync(${JSON.stringify(join(
      targetRoot,
      '.routecodex-v3-test.lock',
      'owner.json',
    ))}, 0o444);`,
  });
  try {
    assert.equal(state.driver.error, undefined, `first driver must not hang: ${state.driver.error?.message ?? ''}`);
    assert.equal(
      state.driver.status,
      CLEANUP_FAILURE_EXIT,
      `owner-write-failure first call must fail closed; stderr:\n${state.driver.stderr}`,
    );
    assert.match(
      state.driver.stderr,
      /unable to persist unreaped process group identity; retaining test lock and artifacts/u,
      'the first call must report that the unreaped identity could not be persisted',
    );
    assert.equal(existsSync(state.lockDir), true, 'owner-write-failure must retain the lock directory');
    assert.equal(existsSync(state.fakeExecutable), true, 'owner-write-failure must retain the old executable');
    assert.equal(existsSync(state.fakeObject), true, 'owner-write-failure must retain the old object');

    const second = startCargoTestDriver("() => ({ status: 0, stdout: '', stderr: '' })", {
      targetRoot: state.targetRoot,
      prepareArtifacts: false,
    });
    try {
      assert.equal(second.driver.error, undefined, `second driver must not hang: ${second.driver.error?.message ?? ''}`);
      assert.equal(
        second.driver.status,
        CLEANUP_FAILURE_EXIT,
        `second call must remain blocked after an owner write failure; stderr:\n${second.driver.stderr}`,
      );
      assert.match(
        second.driver.stderr,
        /execution marker/u,
        'second call must cite the retained execution/unreaped state',
      );
      assert.equal(
        existsSync(second.pidsPath),
        false,
        'blocked second call must never start Cargo on the retained target',
      );
      assert.equal(existsSync(second.fakeExecutable), true, 'blocked second call must not delete the old executable');
      assert.equal(existsSync(second.fakeObject), true, 'blocked second call must not delete the old object');
      assert.equal(existsSync(second.lockDir), true, 'blocked second call must not release the lock');
    } finally {
      closeCargoTestDriver(second, { keepTarget: true });
    }
  } finally {
    closeCargoTestDriver(state, { keepTarget: true });
  }

  // After the retained marker is understood to require the persisted owner,
  // the only safe recovery is the same strict unreaped-group probe against an
  // owner that was never written: it cannot recover here.
  const finalProbe = startCargoTestDriver("() => ({ status: 1, stdout: '', stderr: '' })", {
    targetRoot: state.targetRoot,
    prepareArtifacts: false,
  });
  try {
    assert.equal(
      finalProbe.driver.status,
      CLEANUP_FAILURE_EXIT,
      `no recovery may bypass an unpersisted owner; stderr:\n${finalProbe.driver.stderr}`,
    );
  } finally {
    closeCargoTestDriver(finalProbe);
  }
}

// A non-ESRCH group signal-delivery failure does not prove the group is gone.
// When a follow-up probe reports a live member, the wrapper must fail closed
// with the typed unreaped-group outcome, retain the lock and artifacts, and keep
// the original signal error in the diagnostic detail.
async function assertSignalDeliveryFailureRetainsLockAndArtifacts() {
  const signalErrorPrelude = [
    // Simulate EPERM from the process-group kill while leaving the probe intact.
    '  const realKill = process.kill.bind(process);',
    '  process.kill = (pid, signal) => {',
    "    if (typeof pid === 'number' && pid < 0) {",
    "      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });",
    '    }',
    '    return realKill(pid, signal);',
    '  };',
  ].join('\n');
  const state = startCargoTestDriver(
    "() => ({ status: 0, stdout: '', stderr: '' })",
    {
      executePrelude: signalErrorPrelude,
      // The descendant keeps the group alive but must not hold the driver's
      // stdout pipe, so the parent harness can return and run its cleanup.
      descendantStdio: ['ignore', 'ignore', 'ignore'],
      // The simulated EPERM suppresses the real group kill, so this test-owned
      // driver reaps its own fixture processes before exit. Wrapper behavior
      // (retain lock/artifacts) is what the assertions below check.
      driverExitCleanup: [
        "try {",
        "  const { readFileSync } = await import('node:fs');",
        '  const rec = JSON.parse(readFileSync(fixturePidsPath, \'utf8\'));',
        "  const realKill2 = process.kill;",
        '  for (const pid of [rec.cargoPid, rec.descendantPid]) {',
        "    if (Number.isInteger(pid) && pid > 0) { try { realKill2(pid, 'SIGKILL'); } catch {} }",
        '  }',
        '} catch {}',
      ].join('\n'),
    },
  );
  try {
    assert.equal(state.driver.error, undefined, `driver must not hang: ${state.driver.error?.message ?? ''}`);
    assert.equal(
      state.driver.status,
      CLEANUP_FAILURE_EXIT,
      `an unconfirmed signal-delivery failure must fail the wrapper; stderr:\n${state.driver.stderr}`,
    );
    assert.match(
      state.driver.stderr,
      /signal delivery failed with EPERM/u,
      'the original signal error must remain in the diagnostic detail',
    );
    assert.match(
      state.driver.stderr,
      /process group not confirmed stopped; retaining test lock and artifacts/u,
      'an unconfirmed group must retain the lock and artifacts',
    );
    assert.doesNotMatch(
      state.driver.stdout,
      /debug allocation after cleanup/u,
      'artifact cleanup must not run when the group is not confirmed stopped',
    );
    assert.equal(existsSync(state.fakeExecutable), true, 'test executables must be retained');
    assert.equal(existsSync(state.fakeObject), true, 'compiled test objects must be retained');
    assert.equal(existsSync(state.lockDir), true, 'the canonical test lock must be retained');
  } finally {
    closeCargoTestDriver(state);
  }
}

// The unreaped terminal must not depend on a driver-forced exit: a live Cargo
// process still owns the target, so the wrapper must finish with the typed
// outcome, retain lock/artifacts, and let Node exit through natural process
// lifetime even while the fixture stays alive. The parent harness reaps the
// fixture after observing the wrapper exit, not before.
async function assertUnreapedGroupDoesNotHoldWrapperExit() {
  const state = startCargoTestDriver(
    "() => ({ status: 0, stdout: '', stderr: '' })",
    {
      naturalExit: true,
      captureToFiles: true,
      executePrelude: signalErrorPrelude,
      // The descendant ignores SIGTERM and must stay alive across the driver
      // exit so the ChildProcess handle is the only wrapper-side reference.
      descendantStdio: ['ignore', 'ignore', 'ignore'],
      // The fixture never exits; the wrapper must finish anyway because the
      // unreaped-group outcome unrefs the live child handle.
      exitAfterMs: null,
    },
  );
  try {
    assert.equal(state.driver.error, undefined, `driver must not hang: ${state.driver.error?.message ?? ''}`);
    assert.equal(
      state.driver.status,
      CLEANUP_FAILURE_EXIT,
      `an unconfirmed group must fail the wrapper; stderr:\n${state.driver.stderr}`,
    );
    assert.match(
      state.driver.stderr,
      /process group not confirmed stopped; retaining test lock and artifacts/u,
      'the unreaped outcome must retain the lock and artifacts',
    );
    assert.doesNotMatch(
      state.driver.stdout,
      /debug allocation after cleanup/u,
      'artifact cleanup must not run while the group is unreaped',
    );
    assert.equal(existsSync(state.fakeExecutable), true, 'test executables must be retained');
    assert.equal(existsSync(state.fakeObject), true, 'compiled test objects must be retained');
    assert.equal(existsSync(state.lockDir), true, 'the canonical test lock must be retained');
  } finally {
    closeCargoTestDriver(state);
  }
}

// A confirmed-gone group after a non-ESRCH signal-delivery failure keeps the
// normal timeout/cleanup behavior, but the original signal error must remain
// in the final diagnostic instead of being silently dropped.
async function assertConfirmedGoneRetainsSignalErrorDiagnostic() {
  const state = startCargoTestDriver(
    // The wrapper cannot tell that this probe is lying: the group is still
    // alive, but the probe reports gone so the confirmed-gone branch runs.
    "() => ({ status: 1, stdout: '', stderr: '' })",
    {
      executePrelude: signalErrorPrelude,
      // The fixture must still be alive when the timeout fires at 300ms so the
      // SIGTERM attempt throws EPERM; it then exits at 400ms so the wrapper's
      // close event can settle the timeout after the confirmed-gone probe.
      exitAfterMs: 400,
      descendantStdio: ['ignore', 'ignore', 'ignore'],
      driverExitCleanup: [
        "try {",
        "  const { readFileSync } = await import('node:fs');",
        '  const rec = JSON.parse(readFileSync(fixturePidsPath, \'utf8\'));',
        "  const realKill2 = process.kill;",
        '  for (const pid of [rec.cargoPid, rec.descendantPid]) {',
        "    if (Number.isInteger(pid) && pid > 0) { try { realKill2(pid, 'SIGKILL'); } catch {} }",
        '  }',
        '} catch {}',
      ].join('\n'),
    },
  );
  try {
    assert.equal(state.driver.error, undefined, `driver must not hang: ${state.driver.error?.message ?? ''}`);
    assert.equal(
      state.driver.status,
      CLEANUP_FAILURE_EXIT,
      `the timeout must fail the wrapper; stderr:\n${state.driver.stderr}`,
    );
    assert.match(
      state.driver.stderr,
      /signal delivery failed with EPERM; process group confirmed gone/u,
      'the original signal error must be retained in the confirmed-gone diagnostic',
    );
    assert.match(
      state.driver.stderr,
      /cargo test timed out after 300ms and was terminated/u,
      'the confirmed-gone path must keep the plain timeout diagnostic',
    );
    assert.match(
      state.driver.stdout,
      /debug allocation after cleanup/u,
      'the confirmed-gone path must run artifact cleanup',
    );
    assert.equal(existsSync(state.fakeExecutable), false, 'confirmed reap must release the test executable');
    assert.equal(existsSync(state.fakeObject), false, 'confirmed reap must release compiled test objects');
    assert.equal(existsSync(state.lockDir), false, 'confirmed reap must release the canonical test lock');
  } finally {
    closeCargoTestDriver(state);
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
await assertUnreapedLockSurvivesDeadWrapperPid();
await assertOwnerWriteFailureStillBlocksNextCall();
await assertSignalDeliveryFailureRetainsLockAndArtifacts();
await assertUnreapedGroupDoesNotHoldWrapperExit();
await assertConfirmedGoneRetainsSignalErrorDiagnostic();

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
