import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildMatrixCoverage, finalizeReport, renderMarkdown } from './report.mjs';

test('missing cells and variants stay visible as not covered or not run', () => {
  const report = finalizeReport({
    harness_id: 'selftest',
    status: 'passed',
    config_identity: { check: 0 },
    cases: [baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct')],
  });
  const matrix = report.matrix_cells;
  assert.equal(matrix.length, 16);
  const chatCell = matrix.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat');
  const chatSse = chatCell.variants.find((entry) => entry.transport === 'sse' && entry.mode === 'direct');
  const chatRelay = chatCell.variants.find((entry) => entry.transport === 'json' && entry.mode === 'relay' && entry.supplemental);
  assert.equal(chatSse.status, 'not_run');
  assert.equal(chatRelay.status, 'not_run');
  const emptyCell = matrix.find((entry) => entry.entry_protocol === 'responses' && entry.provider_protocol === 'responses');
  assert.equal(emptyCell.status, 'not_covered');
  const markdown = renderMarkdown(report);
  assert.match(markdown, /not_covered/);
  assert.match(markdown, /sse\/direct: not_run/);
  assert.match(markdown, /json\/relay \(supplemental\): not_run/);
});

test('same-protocol relay supplement is visible without blocking required direct coverage', () => {
  const report = finalizeReport({
    status: 'passed',
    cases: [
      baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'passed'),
      baseCase('openai_chat-to-openai_chat-sse', 'openai_chat', 'openai_chat', 'sse', 'direct', 'passed'),
    ],
  });
  const cell = report.matrix_cells.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat');
  assert.equal(cell.status, 'covered');
  assert.equal(cell.variants.find((entry) => entry.supplemental).status, 'not_run');
  assert.ok(report.supplemental_relay_cells.some((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat'));
});

test('real corpus chat ids are recognized as the openai_chat base matrix', () => {
  const report = finalizeReport({
    status: 'passed',
    cases: [
      baseCase('chat-to-chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'passed'),
      baseCase('chat-to-chat-sse', 'openai_chat', 'openai_chat', 'sse', 'direct', 'passed'),
      baseCase('same-protocol-relay-chat-to-chat-json', 'openai_chat', 'openai_chat', 'json', 'relay', 'passed'),
    ],
  });
  assert.equal(report.boundary_cases.length, 0);
  assert.equal(report.summary.passed, 3);
  const cell = report.matrix_cells.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat');
  assert.equal(cell.status, 'covered');
  assert.equal(cell.variants.find((entry) => entry.supplemental).status, 'passed');
});

test('actual corpus declarations cover every required base variant without claiming execution', () => {
  const fixtureDirectory = fileURLToPath(
    new URL('../../../fixtures/protocol-live-mock-matrix/cases/', import.meta.url),
  );
  const cases = readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')))
    .map((fixture) => ({ case_id: fixture.case_id, cell: fixture.cell, status: 'not_run', diagnostic: 'declared fixture, not executed by this test' }));
  const report = finalizeReport({ status: 'not_run', cases });
  assert.equal(report.summary.total, cases.length);
  assert.equal(report.summary.passed, 0);
  assert.equal(report.status, 'not_run');
  assert.equal(report.matrix_cells.length, 16);
  for (const cell of report.matrix_cells) {
    for (const variant of cell.variants.filter((entry) => !entry.supplemental)) {
      assert.ok(variant.case_ids.length > 0, `${cell.entry_protocol} -> ${cell.provider_protocol} ${variant.transport}/${variant.mode} is missing`);
      assert.equal(variant.status, 'not_run');
    }
  }
  assert.ok(report.boundary_cases.length > 0);
});

test('duplicate case ids are reported but do not inflate matrix or summary counts', () => {
  const duplicate = baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct');
  const report = finalizeReport({ status: 'passed', cases: [duplicate, { ...duplicate }] });
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.entries, 2);
  assert.equal(report.summary.passed, 1);
  assert.deepEqual(report.summary.duplicate_case_ids, ['openai_chat-to-openai_chat-json']);
  const chatCell = report.matrix_cells.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat');
  const jsonDirect = chatCell.variants.find((entry) => entry.transport === 'json' && entry.mode === 'direct');
  assert.deepEqual(jsonDirect.case_ids, ['openai_chat-to-openai_chat-json']);
  assert.equal(jsonDirect.case_count, 1);
  assert.match(renderMarkdown(report), /duplicate case ids: `openai_chat-to-openai_chat-json`/);
});

test('startup failure is classified as infrastructure and never counted as product failure or pass', () => {
  const report = finalizeReport({
    status: 'runner_startup_failed',
    cases: [{ case_id: 'startup-smoke', cell: { entry_protocol: 'openai_chat', provider_protocol: 'openai_chat', transport: 'json', mode: 'direct' }, status: 'not_run', diagnostic: 'server startup failed' }],
  });
  assert.equal(report.status, 'infra_failed');
  assert.equal(report.summary.passed, 0);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.infra_failure, 1);
  assert.equal(report.summary.product_failures, 0);
  assert.equal(report.cases[0].status, 'infra_failure');
  assert.match(renderMarkdown(report), /infra_failure/);
});

test('mixed statuses are counted exactly and missing variants remain distinct', () => {
  const report = finalizeReport({
    status: 'running',
    cases: [
      baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'passed'),
      baseCase('openai_chat-to-openai_chat-sse', 'openai_chat', 'openai_chat', 'sse', 'direct', 'failed', { diagnostic: 'client status 500 != 200' }),
      baseCase('responses-to-openai_chat-json', 'responses', 'openai_chat', 'json', 'relay', 'not_run', { diagnostic: 'not sent' }),
      baseCase('responses-to-openai_chat-sse', 'responses', 'openai_chat', 'sse', 'relay', 'infra_failure', { diagnostic: 'runner error: fixture load failed' }),
    ],
  });
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.not_run, 1);
  assert.equal(report.summary.infra_failure, 1);
  assert.equal(report.status, 'infra_failed');
  const sseCell = report.matrix_cells.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat');
  assert.equal(sseCell.variants.find((entry) => entry.transport === 'sse' && entry.mode === 'direct').status, 'failed');
});

test('zero runs with a passing config check do not become successful matrix evidence', () => {
  const report = finalizeReport({ status: 'passed', config_identity: { check: 0 }, cases: [] });
  assert.equal(report.status, 'not_run');
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.passed, 0);
  assert.ok(report.matrix_cells.every((entry) => entry.status === 'not_covered'));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /unique cases: `0`/);
  assert.match(markdown, /status: `not_run`/);
  assert.doesNotMatch(markdown, /%/);
});

test('incomplete cleanup remains visible in the machine report and markdown', () => {
  const report = finalizeReport({
    status: 'baseline_completed_with_failures',
    cleanup: { complete: false, force_killed: true, pid: 1234, exit_code: null, signal: 'SIGKILL' },
    cases: [baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'failed', { diagnostic: 'provider capture missing' })],
  });
  assert.equal(report.cleanup.complete, false);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /complete: `false`/);
  assert.match(markdown, /force_killed: `true`/);
});

test('render keeps original red diagnostics, identities, and stable evidence references', () => {
  const report = finalizeReport({
    status: 'baseline_completed_with_failures',
    evidence_root: '/persistent/evidence/run-1',
    binary: { path: '/opt/rccv3', version: '0.90.4873', sha256: 'runtime-sha' },
    source: { repo: 'https://github.com/yetone/magpie', sha: 'source-sha' },
    fixture_digest: 'fixture-digest',
    cleanup: { complete: true, exit_code: 0, signal: null },
    cases: [
      baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'failed', {
        diagnostic: 'client status 500 != 200',
        captures: [join('/persistent/evidence/run-1', 'captures', 'openai_chat-to-openai_chat-json.json')],
      }),
    ],
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /client status 500 != 200/);
  assert.match(markdown, /\/opt\/rccv3/);
  assert.match(markdown, /runtime-sha/);
  assert.match(markdown, /source-sha/);
  assert.match(markdown, /captures\/openai_chat-to-openai_chat-json\.json/);
});

test('temporary evidence roots do not claim persistent report evidence', () => {
  const report = finalizeReport({
    status: 'baseline_completed_with_failures',
    evidence_root: '/tmp/magpie-run-1',
    cases: [
      baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'failed', {
        diagnostic: 'red',
        captures: ['/tmp/magpie-run-1/captures/openai_chat-to-openai_chat-json.json'],
      }),
    ],
  });
  assert.equal(report.evidence.persistent, false);
  assert.equal(report.evidence.references[0].persistent, false);
  assert.match(renderMarkdown(report), /root persistent: `false`/);
});

test('P2 handoff groups only evidenced first external divergence and leaves unknown explicit', () => {
  const report = finalizeReport({
    status: 'baseline_completed_with_failures',
    cases: [
      baseCase('openai_chat-to-responses-json', 'openai_chat', 'responses', 'json', 'relay', 'failed', {
        diagnostic: 'provider path mismatch',
        first_divergence: 'provider wire projection',
      }),
      baseCase('openai_chat-to-anthropic-json', 'openai_chat', 'anthropic', 'json', 'relay', 'failed', {
        diagnostic: 'no external divergence recorded',
      }),
    ],
  });
  assert.deepEqual(report.p2_handoff.map((entry) => entry.first_divergence), ['provider wire projection', 'unknown']);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /### provider wire projection/);
  assert.match(markdown, /### unknown/);
});

test('boundary cases are separate from the sixteen base matrix cells', () => {
  const boundary = {
    case_id: 'tool-followup-responses-to-chat',
    cell: { entry_protocol: 'responses', provider_protocol: 'openai_chat', transport: 'sse', mode: 'relay' },
    status: 'failed',
    diagnostic: 'tool argument mismatch',
  };
  const report = finalizeReport({ status: 'baseline_completed_with_failures', cases: [boundary] });
  assert.equal(report.boundary_cases.length, 1);
  assert.ok(!report.matrix_cells.flatMap((entry) => entry.variants).flatMap((entry) => entry.case_ids).includes(boundary.case_id));
  assert.match(renderMarkdown(report), /## Boundary Scope/);
  assert.match(renderMarkdown(report), /tool-followup-responses-to-chat/);
});

test('finalizeReport returns a new report and does not mutate the input', () => {
  const input = {
    status: 'baseline_completed_with_failures',
    cases: [baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'failed', { diagnostic: 'red' })],
  };
  const before = structuredClone(input);
  const output = finalizeReport(input);
  assert.notEqual(output, input);
  assert.deepEqual(input, before);
  assert.equal(output.cases[0].case_id, input.cases[0].case_id);
});

test('buildMatrixCoverage deduplicates duplicate ids without hiding failures', () => {
  const duplicatePass = baseCase('openai_chat-to-openai_chat-json', 'openai_chat', 'openai_chat', 'json', 'direct', 'passed');
  const duplicateFail = { ...duplicatePass, status: 'failed', diagnostic: 'late red result' };
  const matrix = buildMatrixCoverage([duplicatePass, duplicateFail]);
  const variant = matrix.find((entry) => entry.entry_protocol === 'openai_chat' && entry.provider_protocol === 'openai_chat').variants.find((entry) => entry.transport === 'json' && entry.mode === 'direct');
  assert.deepEqual(variant.case_ids, ['openai_chat-to-openai_chat-json']);
  assert.equal(variant.case_count, 1);
});

function baseCase(caseId, entryProtocol, providerProtocol, transport, mode, status = 'passed', extra = {}) {
  return {
    case_id: caseId,
    cell: { entry_protocol: entryProtocol, provider_protocol: providerProtocol, transport, mode },
    status,
    diagnostic: status === 'passed' ? 'baseline assertions passed' : 'synthetic red',
    ...extra,
  };
}
