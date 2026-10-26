#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'scripts', 'run-v3-cargo-test.mjs'), 'utf8');
const { executeCargo } = await import('../run-v3-cargo-test.mjs');

function writeTimeoutFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'routecodex-v3-cargo-timeout-'));
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
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
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

await assertDescendantHoldingStdoutIsBounded();
await assertEarlyCargoExitStillReapsGroupAndSettles();

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

process.stdout.write('[test:v3-cargo-test-timeout-regression] PASS\n');
