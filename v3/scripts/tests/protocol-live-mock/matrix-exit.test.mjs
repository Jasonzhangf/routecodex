import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matrixExitCode } from '../v3-protocol-live-mock-matrix.mjs';

function caseEntry(overrides = {}) {
  const entry = {
    case_id: 'case',
    status: 'passed',
    classification: 'pass',
    ...overrides,
  };
  return { raw_status: entry.status, ...entry };
}

function result(overrides = {}) {
  const base = {
    status: 'passed',
    summary: { total: 1, passed: 1, failed: 0, not_run: 0, infra_failure: 0 },
    cleanup: { complete: true },
    cases: [caseEntry()],
  };
  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...(overrides.summary ?? {}) },
    cleanup: { ...base.cleanup, ...(overrides.cleanup ?? {}) },
    cases: overrides.cases ?? base.cases,
  };
}

test('passed result exits 0 with or without capability-skip flag', () => {
  assert.equal(matrixExitCode(result()), 0);
  assert.equal(matrixExitCode(result(), { allowCapabilitySkips: true }), 0);
});

test('passed status with summary.passed=0 exits 1 in both modes', () => {
  const forged = result({ status: 'passed', summary: { total: 1, passed: 0 } });
  assert.equal(matrixExitCode(forged), 1);
  assert.equal(matrixExitCode(forged, { allowCapabilitySkips: true }), 1);
});

test('summary.failed exits 1 even when capability skips are allowed', () => {
  const failed = result({
    status: 'baseline_completed_with_failures',
    summary: { failed: 1 },
    cases: [caseEntry({ status: 'failed', classification: 'product' })],
  });
  assert.equal(matrixExitCode(failed, { allowCapabilitySkips: true }), 1);
});

test('summary.infra_failure exits 1 even when capability skips are allowed', () => {
  const infra = result({
    status: 'infra_failed',
    summary: { infra_failure: 1 },
    cases: [caseEntry({ status: 'infra_failure', classification: 'infrastructure' })],
  });
  assert.equal(matrixExitCode(infra, { allowCapabilitySkips: true }), 1);
});

test('summary.runner_failures exits 1 even when capability skips are allowed', () => {
  const runnerFailed = result({
    status: 'not_run',
    summary: { total: 2, passed: 1, not_run: 1, runner_failures: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'skip', status: 'not_run', classification: 'capability' })],
  });
  assert.equal(matrixExitCode(runnerFailed, { allowCapabilitySkips: true }), 1);
});

test('incomplete cleanup exits 1 even when capability skips are allowed', () => {
  assert.equal(matrixExitCode(result({ cleanup: { complete: false } }), { allowCapabilitySkips: true }), 1);
});

test('strict mode rejects capability-classified not_run', () => {
  const skipped = result({
    status: 'not_run',
    summary: { total: 2, passed: 1, not_run: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'skip', status: 'not_run', classification: 'capability' })],
  });
  assert.equal(matrixExitCode(skipped), 1);
});

test('flag allows capability-classified not_run when another case passed', () => {
  const skipped = result({
    status: 'not_run',
    summary: { total: 2, passed: 1, not_run: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'skip', status: 'not_run', classification: 'capability' })],
  });
  assert.equal(matrixExitCode(skipped, { allowCapabilitySkips: true }), 0);
});

test('flag still rejects halted not_run without capability classification', () => {
  const halted = result({
    status: 'not_run',
    summary: { total: 2, passed: 1, not_run: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'halt', status: 'not_run', classification: null })],
  });
  assert.equal(matrixExitCode(halted, { allowCapabilitySkips: true }), 1);
});

test('flag still rejects a result with no passed case', () => {
  const empty = result({
    status: 'not_run',
    summary: { total: 1, passed: 0, not_run: 1 },
    cases: [caseEntry({ status: 'not_run', classification: 'capability' })],
  });
  assert.equal(matrixExitCode(empty, { allowCapabilitySkips: true }), 1);
});

test('non-null halt_reason exits 1 in strict and permissive modes', () => {
  const halted = result({ halt_reason: 'owned resource cleanup incomplete' });
  assert.equal(matrixExitCode(halted), 1);
  assert.equal(matrixExitCode(halted, { allowCapabilitySkips: true }), 1);
});

test('unknown raw status cannot be treated as a capability skip in either mode', () => {
  const unknown = result({
    status: 'not_run',
    summary: { total: 2, passed: 1, not_run: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'skip', status: 'not_run', raw_status: 'unknown_status',
      classification: 'capability' })],
  });
  assert.equal(matrixExitCode(unknown), 1);
  assert.equal(matrixExitCode(unknown, { allowCapabilitySkips: true }), 1);
});

test('duplicate entries cannot hide a non-capability raw entry in either mode', () => {
  const duplicated = result({
    status: 'not_run',
    summary: { total: 2, entries: 3, passed: 1, not_run: 1, duplicate_entries: 1 },
    cases: [caseEntry(), caseEntry({ case_id: 'dup', status: 'not_run', classification: 'capability' })],
    entries: [
      caseEntry(),
      caseEntry({ case_id: 'dup', status: 'not_run', classification: 'capability' }),
      caseEntry({ case_id: 'dup', status: 'failed', classification: 'product' }),
    ],
  });
  assert.equal(matrixExitCode(duplicated), 1);
  assert.equal(matrixExitCode(duplicated, { allowCapabilitySkips: true }), 1);
});
