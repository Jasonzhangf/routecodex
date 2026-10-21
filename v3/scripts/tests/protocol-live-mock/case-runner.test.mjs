import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { collectExecutionModeEvidence, runCase } from './case-runner.mjs';
import { applyExecutionModeAcceptance, collectCaseExecutionModeEvidence } from '../v3-protocol-live-mock-matrix.mjs';
import {
  createMock,
  simpleFixture,
  tempEvidenceRoot,
  TEST_PROVIDER_AUTH,
} from './case-runner-test-support.mjs';
import { describeTurns } from './case-contract.mjs';

const caseRoot = new URL('../../../fixtures/protocol-live-mock-matrix/cases/', import.meta.url);
test('required mode collector exception fails acceptance and preserves prior business failure', () => {
  const mode = collectCaseExecutionModeEvidence({ caseId: 'anthropic-to-anthropic-json', caseRoot: Symbol('invalid evidence path') });
  assert.equal(mode.status, 'incomplete');
  assert.equal(mode.expected_mode, 'direct');
  assert.match(mode.findings.join('; '), /collector error:/);
  const entry = { status: 'passed', diagnostic: 'business passed', execution_mode: mode };
  applyExecutionModeAcceptance(entry);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.classification, 'evidence');
  const failed = { status: 'infra_failure', diagnostic: 'owned resource cleanup incomplete', execution_mode: mode };
  applyExecutionModeAcceptance(failed);
  assert.equal(failed.status, 'infra_failure');
  assert.match(failed.diagnostic, /^owned resource cleanup incomplete;/);
});
function loadCase(id) {
  return JSON.parse(readFileSync(new URL(`${id}.json`, caseRoot), 'utf8'));
}

test('runCase passes a single-turn case through the supplied real HTTP adapter and writes raw evidence', async () => {
  const root = tempEvidenceRoot();
  try {
    const mock = createMock(simpleFixture);
    const report = await runCase({
      fixture: simpleFixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.classification, 'pass');
    assert.equal(report.provider_attempt_count, 1);
    assert.equal(report.probe_attempt_count, 0);
    assert.deepEqual(mock.calls, [{
      url: 'http://127.0.0.1:0/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: TEST_PROVIDER_AUTH,
      },
      body: JSON.stringify(simpleFixture.client_request.body),
      timeoutMs: 30000,
      turn_index: 0,
    }]);
    assert.equal(report.turn_results.length, 1);
    assert.deepEqual(report.turn_results[0].request_source, 'fixture');
    assert.equal(report.evidence_refs.length, 2);
    assert.equal(report.source_provenance.verified, false);
    assert.match(report.source_provenance.note, /no provenance claim/u);

    const clientEvidence = JSON.parse(readFileSync(join(root, 'captures', 'module-chat-direct-json-turn-1-client.json'), 'utf8'));
    assert.equal(clientEvidence.request.body_text, JSON.stringify(simpleFixture.client_request.body));
    assert.ok(clientEvidence.client_response.bodyBytesBase64.length > 0);
    assert.ok(clientEvidence.observation, 'protocol observation must be preserved');
    assert.ok(Number.isInteger(clientEvidence.attempt.send_started_epoch_ms));
    assert.ok(Number.isInteger(clientEvidence.attempt.send_settled_epoch_ms));
    assert.equal(clientEvidence.attempt.outcome, 'settled');
    assert.equal(report.turn_attempts[0].outcome, 'settled');
    assert.equal(report.observations.live[0].attempt.outcome, 'settled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeTurns accepts a later turn provider body contract', () => {
  const fixture = {
    client_request: { method: 'POST', path: '/v1/responses', body: {} },
    expected_provider: {
      paths: ['/v1/responses'],
      method: 'POST',
      auth_required: true,
      body_must: { stream: false },
      exact: null,
    },
    upstream_response: {
      protocol: 'responses',
      mode: 'json',
      body: { status: 'completed' },
    },
    turns: [
      { turn_id: 'first' },
      {
        turn_id: 'second',
        client_request: { method: 'POST', path: '/v1/responses', body: { stream: true } },
        expected_provider: {
          paths: ['/v1/responses'],
          method: 'POST',
          auth_required: true,
          body_must: { 'input.1.type': 'reasoning', stream: true },
          body_must_not: ['input.1.encrypted_content'],
          exact: null,
        },
        upstream_response: {
          protocol: 'responses',
          mode: 'sse',
          sse_events: [{ event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } }],
        },
      },
    ],
  };
  const turns = describeTurns(fixture);
  assert.equal(turns[0].providerExpected.body_must.stream, false);
  assert.deepEqual(turns[1].providerExpected.body_must, {
    'input.1.type': 'reasoning',
    stream: true,
  });
  assert.deepEqual(turns[1].providerExpected.body_must_not, ['input.1.encrypted_content']);
  assert.equal(turns[1].upstream.mode, 'sse');
});

// ---- persisted execution-mode collector (real schema-v1 files) ----

function persistedRow(overrides = {}) {
  const { meta = {}, scope = {}, ...rest } = overrides;
  return {
    request_key: '4555:req_1',
    event_type: 'request.completed',
    started_epoch_ms: 1000,
    updated_epoch_ms: 1040,
    finished_epoch_ms: 1050,
    duration_ms: 50,
    meta: {
      request_id: 'req_1',
      endpoint: '/v1/messages',
      entry_protocol: 'anthropic',
      execution_mode: 'direct',
      ...meta,
    },
    scope: { port: 4555, ...scope },
    result: 'success',
    attempts: 1,
    failed_attempts: 0,
    switches: 0,
    ...rest,
  };
}

function writePersistedStore(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify({ schema_version: 1, row })).join('\n')}\n`);
  return path;
}

function attemptReceipt(overrides = {}) {
  return {
    attempt_index: 0,
    turn: 1,
    turn_index: 0,
    turn_id: null,
    source: 'fixture',
    endpoint: '/v1/messages',
    method: 'POST',
    entry_protocol: 'anthropic',
    send_started_epoch_ms: 1000,
    send_settled_epoch_ms: 1050,
    outcome: 'settled',
    failure_code: null,
    failure_message: null,
    ...overrides,
  };
}

function businessCapture(overrides = {}) {
  return {
    attempt_kind: 'business',
    case_id: 'anthropic-to-anthropic-json',
    turn: 0,
    captured_at_epoch_ms: 1010,
    path: '/v1/messages',
    ...overrides,
  };
}

test('execution-mode collector folds repeated snapshots and proves persisted Direct mode', () => {
  const root = tempEvidenceRoot();
  try {
    const storePath = join(root, 'server-v3-4555.request-records.jsonl');
    writePersistedStore(storePath, [
      persistedRow({ event_type: 'request.started', updated_epoch_ms: 1000, finished_epoch_ms: null, meta: { execution_mode: null } }),
      persistedRow({ event_type: 'request.completed', updated_epoch_ms: 1040, finished_epoch_ms: 1050, meta: { execution_mode: 'direct' } }),
    ]);
    const result = collectExecutionModeEvidence({
      caseId: 'anthropic-to-anthropic-json',
      caseRoot: root,
      storePath,
      listenerPort: 4555,
      attempts: [attemptReceipt()],
      captures: [businessCapture()],
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'pass', result.findings.join('; '));
    assert.equal(result.expected_mode, 'direct');
    assert.equal(result.actual_mode, 'direct');
    assert.equal(result.raw_record_count, 2);
    assert.equal(result.folded_record_count, 1);
    assert.equal(result.turns[0].request_id, 'req_1');
    assert.equal(result.turns[0].request_key, '4555:req_1');
    assert.ok(readFileSync(result.records_ref).length > 0);
    const evidence = JSON.parse(readFileSync(result.evidence_ref, 'utf8'));
    assert.equal(evidence.actual_mode, 'direct');
    assert.equal(evidence.request_ids[0], 'req_1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution-mode collector keeps a wrong observed mode visible and fails acceptance', () => {
  const root = tempEvidenceRoot();
  try {
    const storePath = join(root, 'server-v3-4555.request-records.jsonl');
    writePersistedStore(storePath, [persistedRow({
      meta: { endpoint: '/v1/chat/completions', entry_protocol: 'openai_chat', execution_mode: 'direct' },
    })]);
    const result = collectExecutionModeEvidence({
      caseId: 'same-protocol-relay-chat-to-chat-json',
      caseRoot: root,
      storePath,
      listenerPort: 4555,
      attempts: [attemptReceipt({ endpoint: '/v1/chat/completions', entry_protocol: 'openai_chat' })],
      captures: [businessCapture({ case_id: 'same-protocol-relay-chat-to-chat-json', path: '/v1/chat/completions' })],
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.expected_mode, 'relay');
    assert.equal(result.actual_mode, 'direct');
    assert.match(result.findings.join('; '), /expected relay, observed direct/u);
    const entry = { status: 'passed', diagnostic: 'business passed', execution_mode: result };
    applyExecutionModeAcceptance(entry);
    assert.equal(entry.status, 'failed');
    assert.equal(entry.classification, 'product');
    assert.equal(entry.product_failures, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution-mode collector reports missing persisted records as incomplete', () => {
  const root = tempEvidenceRoot();
  try {
    const result = collectExecutionModeEvidence({
      caseId: 'anthropic-to-anthropic-json',
      caseRoot: root,
      storePath: join(root, 'server-v3-4555.request-records.jsonl'),
      listenerPort: 4555,
      attempts: [attemptReceipt()],
      captures: [businessCapture()],
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'incomplete');
    assert.notEqual(result.status, 'pass');
    assert.equal(result.actual_mode, null);
    assert.match(result.findings.join('; '), /store missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution-mode collector rejects probe and unrelated rows instead of taking the last row', () => {
  const root = tempEvidenceRoot();
  try {
    const storePath = join(root, 'server-v3-4555.request-records.jsonl');
    writePersistedStore(storePath, [
      persistedRow({
        request_key: '4555:other',
        started_epoch_ms: 1000,
        meta: { request_id: 'other', endpoint: '/v1/responses', execution_mode: 'relay' },
      }),
      persistedRow({
        request_key: '4555:probe',
        started_epoch_ms: 1001,
        meta: { request_id: 'probe', endpoint: '/v1/models', execution_mode: 'direct' },
      }),
    ]);
    const result = collectExecutionModeEvidence({
      caseId: 'anthropic-to-anthropic-json',
      caseRoot: root,
      storePath,
      listenerPort: 4555,
      attempts: [attemptReceipt()],
      captures: [
        { attempt_kind: 'probe', case_id: null, turn: 0, captured_at_epoch_ms: 1002 },
        businessCapture(),
      ],
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.actual_mode, null);
    assert.deepEqual(result.turns[0].candidate_request_keys, []);
    assert.match(result.findings.join('; '), /no persisted record/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution-mode collector reports ambiguous candidate ids instead of choosing one', () => {
  const root = tempEvidenceRoot();
  try {
    const storePath = join(root, 'server-v3-4555.request-records.jsonl');
    writePersistedStore(storePath, [
      persistedRow({ request_key: '4555:a', started_epoch_ms: 1200, meta: { request_id: 'a', execution_mode: 'direct' } }),
      persistedRow({ request_key: '4555:b', started_epoch_ms: 1210, meta: { request_id: 'b', execution_mode: 'relay' } }),
    ]);
    const result = collectExecutionModeEvidence({
      caseId: 'anthropic-to-anthropic-json',
      caseRoot: root,
      storePath,
      listenerPort: 4555,
      attempts: [attemptReceipt({ send_started_epoch_ms: 1200, send_settled_epoch_ms: 1250 })],
      captures: [businessCapture({ captured_at_epoch_ms: 1205 })],
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.actual_mode, null);
    assert.deepEqual([...result.turns[0].candidate_request_keys].sort(), ['4555:a', '4555:b']);
    assert.match(result.findings.join('; '), /multiple persisted records/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution-mode collector treats a partial stop and a nonterminal row as incomplete', () => {
  const root = tempEvidenceRoot();
  try {
    const storePath = join(root, 'server-v3-4555.request-records.jsonl');
    writePersistedStore(storePath, [persistedRow({ event_type: 'request.started', finished_epoch_ms: null })]);
    const base = {
      caseId: 'anthropic-to-anthropic-json',
      caseRoot: root,
      storePath,
      listenerPort: 4555,
      attempts: [attemptReceipt()],
      captures: [businessCapture()],
    };
    const partial = collectExecutionModeEvidence({ ...base, collectionPhase: 'post_stop_partial' });
    assert.equal(partial.status, 'incomplete');
    assert.match(partial.findings.join('; '), /cannot prove flush completeness/u);

    const nonterminal = collectExecutionModeEvidence({ ...base, collectionPhase: 'post_stop_complete' });
    assert.equal(nonterminal.status, 'incomplete');
    assert.match(nonterminal.findings.join('; '), /not a request\.completed terminal/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase retains a failed-send attempt receipt when processTurn never runs', async () => {
  const root = tempEvidenceRoot();
  try {
    const fixture = structuredClone(simpleFixture);
    fixture.case_id = 'module-attempt-send-failure';
    const mock = createMock(fixture);
    mock.sendHttp = async () => { throw new Error('adapter refused'); };
    const report = await runCase({
      fixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(report.status, 'infra_failure');
    assert.equal(report.turn_attempts.length, 1);
    const attempt = report.turn_attempts[0];
    assert.equal(attempt.outcome, 'send_rejected');
    assert.equal(attempt.failure_code, 'HTTP_ADAPTER');
    assert.ok(Number.isInteger(attempt.send_started_epoch_ms));
    assert.ok(Number.isInteger(attempt.send_settled_epoch_ms));
    assert.ok(attempt.send_settled_epoch_ms >= attempt.send_started_epoch_ms);
    assert.equal(report.observations.live.length, 0);
    assert.match(report.diagnostic, /http adapter rejected/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase reports a dispatched client timeout as product close, not endpoint unavailability', async () => {
  const root = tempEvidenceRoot();
  try {
    const timeoutFixture = structuredClone(simpleFixture);
    timeoutFixture.case_id = 'module-client-timeout-after-dispatch';
    timeoutFixture.expected_client = {
      transport: 'closed',
      status: null,
      body_must: {},
      body_must_not: ['empty_body'],
      semantic_terminal_required: false,
    };
    const timeoutMock = createMock(timeoutFixture, {
      transformResult: () => ({
        status: null,
        status_text: null,
        headers: {},
        raw_headers: [],
        body: null,
        bodyText: '',
        bodyBytes: Buffer.alloc(0),
        bodyBytesBase64: '',
        response_ended: false,
        complete: false,
        closed: true,
        aborted: false,
        truncated: false,
        elapsed_ms: 1,
        error: 'request timed out after 30000ms',
        error_detail: { name: 'Error', message: 'request timed out after 30000ms', code: 'ETIMEDOUT' },
      }),
    });
    const timeoutReport = await runCase({
      fixture: timeoutFixture,
      mock: timeoutMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: timeoutMock.sendHttp,
      evidenceRoot: root,
    });
    // The mock records the business attempt before returning ETIMEDOUT, so the
    // endpoint was reachable. The failure belongs to the product close surface.
    assert.equal(timeoutReport.classification, 'product', timeoutReport.diagnostic);
    assert.match(
      timeoutReport.diagnostic,
      /expected product socket close but the test client stopped: ETIMEDOUT/u,
    );

    const noDispatchMock = createMock(timeoutFixture);
    noDispatchMock.sendHttp = async () => ({
      status: null,
      status_text: null,
      headers: {},
      raw_headers: [],
      body: null,
      bodyText: '',
      bodyBytes: Buffer.alloc(0),
      bodyBytesBase64: '',
      response_ended: false,
      complete: false,
      closed: true,
      aborted: false,
      truncated: false,
      elapsed_ms: 1,
      error: 'connect timed out',
      error_detail: { name: 'Error', message: 'connect timed out', code: 'ETIMEDOUT' },
    });
    const noDispatchReport = await runCase({
      fixture: timeoutFixture,
      mock: noDispatchMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: noDispatchMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(noDispatchReport.status, 'infra_failure');
    assert.equal(noDispatchReport.classification, 'infrastructure');
    assert.match(noDispatchReport.diagnostic, /endpoint unavailable.*ETIMEDOUT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase uses the provider sequence assertion only when auth_orders is declared', async () => {
  const root = tempEvidenceRoot();
  const tokenA = 'Bearer fake-loopback-token-mock-chat-a';
  const tokenB = 'Bearer fake-loopback-token-mock-chat-b';
  const sequenceFixture = structuredClone(simpleFixture);
  sequenceFixture.case_id = 'module-provider-sequence';
  sequenceFixture.expected_provider.auth_orders = [
    [tokenA, tokenB],
    [tokenB, tokenA],
  ];
  sequenceFixture.assertions.provider_attempt_count = 2;
  sequenceFixture.upstream_response = {
    ...sequenceFixture.upstream_response,
    attempts: [
      { kind: 'json', status: 200, content_type: 'application/json', body: sequenceFixture.upstream_response.body },
      { kind: 'json', status: 200, content_type: 'application/json', body: sequenceFixture.upstream_response.body },
    ],
  };
  try {
    const validMock = createMock(sequenceFixture, { providerAttemptIdentities: [tokenA, tokenB] });
    const valid = await runCase({
      fixture: sequenceFixture,
      mock: validMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: validMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(valid.status, 'passed', valid.diagnostic);

    const repeatedMock = createMock(sequenceFixture, { providerAttemptIdentities: [tokenA, tokenA] });
    const repeated = await runCase({
      fixture: sequenceFixture,
      mock: repeatedMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: repeatedMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(repeated.status, 'failed');
    assert.match(repeated.diagnostic, /repeated provider auth identity/u);
    assert.match(repeated.diagnostic, /not an allowed order/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase rejects wrong request client/terminal evidence and wrong provider attempt count', async () => {
  const root = tempEvidenceRoot();
  try {
    const wrongClientFixture = structuredClone(simpleFixture);
    wrongClientFixture.case_id = 'module-wrong-client';
    wrongClientFixture.expected_client.body_must['choices.0.message.content'] = 'not-ok';
    const wrongClientMock = createMock(wrongClientFixture);
    const wrongClientReport = await runCase({
      fixture: wrongClientFixture,
      mock: wrongClientMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: wrongClientMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(wrongClientReport.status, 'failed');
    assert.equal(wrongClientReport.classification, 'product');
    assert.match(wrongClientReport.diagnostic, /client body_must choices\.0\.message\.content mismatch/u);

    const missingTerminalFixture = structuredClone(simpleFixture);
    missingTerminalFixture.case_id = 'module-missing-terminal';
    missingTerminalFixture.upstream_response.body.choices[0].finish_reason = null;
    const missingTerminalMock = createMock(missingTerminalFixture);
    const missingTerminalReport = await runCase({
      fixture: missingTerminalFixture,
      mock: missingTerminalMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: missingTerminalMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(missingTerminalReport.status, 'failed');
    assert.match(missingTerminalReport.diagnostic, /semantic terminal missing/u);

    const wrongCountFixture = structuredClone(simpleFixture);
    wrongCountFixture.case_id = 'module-wrong-attempt-count';
    wrongCountFixture.assertions.provider_attempt_count = 2;
    const wrongCountMock = createMock(wrongCountFixture);
    const wrongCountReport = await runCase({
      fixture: wrongCountFixture,
      mock: wrongCountMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: wrongCountMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(wrongCountReport.status, 'failed');
    assert.match(wrongCountReport.diagnostic, /provider attempt count 1 != asserted 2/u);

    const controlLeakFixture = structuredClone(simpleFixture);
    controlLeakFixture.case_id = 'module-control-leak';
    controlLeakFixture.client_request.body.routecodex_internal = 'leak';
    controlLeakFixture.expected_provider.exact = structuredClone(controlLeakFixture.client_request.body);
    const controlLeakMock = createMock(controlLeakFixture);
    const controlLeakReport = await runCase({
      fixture: controlLeakFixture,
      mock: controlLeakMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: controlLeakMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(controlLeakReport.status, 'failed');
    assert.match(controlLeakReport.diagnostic, /control marker/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase classifies setup and missing capabilities as explicit non-product outcomes', async () => {
  const root = tempEvidenceRoot();
  try {
    const unavailableFixture = structuredClone(simpleFixture);
    unavailableFixture.case_id = 'module-endpoint-unavailable';
    const unavailableReport = await runCase({
      fixture: unavailableFixture,
      mock: createMock(unavailableFixture),
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: async () => ({ status: null, headers: {}, body: null, bodyText: '', response_ended: false, closed: true, error: 'connect ECONNREFUSED', error_detail: { code: 'ECONNREFUSED' } }),
      evidenceRoot: root,
    });
    assert.equal(unavailableReport.status, 'infra_failure');
    assert.equal(unavailableReport.classification, 'infrastructure');
    assert.match(unavailableReport.diagnostic, /endpoint unavailable.*ECONNREFUSED/u);
    assert.equal(unavailableReport.observations.infra.length, 1);

    const missingCapabilityReport = await runCase({
      fixture: simpleFixture,
      mock: { getCaptures: () => [] },
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: async () => { throw new Error('must not send without mock capabilities'); },
      evidenceRoot: root,
    });
    assert.equal(missingCapabilityReport.status, 'not_run');
    assert.equal(missingCapabilityReport.classification, 'capability');
    assert.match(missingCapabilityReport.diagnostic, /capability_missing: mock\.setActiveCase required/u);
    assert.match(missingCapabilityReport.diagnostic, /capability_missing: mock\.setTurn required/u);
    assert.equal(missingCapabilityReport.product_failures, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase keeps failed parse diagnostics separate from parsed client observations', async () => {
  const root = tempEvidenceRoot();
  try {
    const closedFixture = structuredClone(simpleFixture);
    closedFixture.case_id = 'module-closed-empty-body';
    closedFixture.expected_client = {
      transport: 'closed',
      status: null,
      body_must: {},
      body_must_not: ['empty_body'],
      semantic_terminal_required: false,
    };
    const closedMock = createMock(closedFixture, {
      transformResult: () => ({
        status: null,
        status_text: null,
        headers: {},
        raw_headers: [],
        body: null,
        bodyText: '',
        bodyBytes: Buffer.alloc(0),
        bodyBytesBase64: '',
        response_ended: false,
        complete: false,
        closed: true,
        aborted: false,
        truncated: false,
        elapsed_ms: 1,
        error: null,
        error_detail: null,
      }),
    });
    const closedReport = await runCase({
      fixture: closedFixture,
      mock: closedMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: closedMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(closedReport.status, 'passed', closedReport.diagnostic);

    const closedEvidence = JSON.parse(readFileSync(
      join(root, 'captures', 'module-closed-empty-body-turn-1-client.json'),
      'utf8',
    ));
    assert.equal(closedEvidence.observation, null);
    assert.equal(closedEvidence.parse_diagnostic.error, 'empty_body');
    assert.equal(closedEvidence.client_response.status, null);
    assert.equal(closedEvidence.client_response.bodyText, '');

    const jsonFixture = structuredClone(closedFixture);
    jsonFixture.case_id = 'module-closed-real-json-empty-body-shape';
    const jsonBody = { ok: false, error: 'empty_body' };
    const jsonBodyText = JSON.stringify(jsonBody);
    const jsonMock = createMock(jsonFixture, {
      transformResult: () => ({
        status: 200,
        status_text: 'OK',
        headers: { 'content-type': 'application/json' },
        raw_headers: [['content-type', 'application/json']],
        body: jsonBody,
        bodyText: jsonBodyText,
        bodyBytes: Buffer.from(jsonBodyText, 'utf8'),
        bodyBytesBase64: Buffer.from(jsonBodyText, 'utf8').toString('base64'),
        response_ended: true,
        complete: true,
        closed: false,
        aborted: false,
        truncated: false,
        elapsed_ms: 1,
        error: null,
        error_detail: null,
      }),
    });
    const jsonReport = await runCase({
      fixture: jsonFixture,
      mock: jsonMock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: jsonMock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(jsonReport.status, 'failed');
    assert.match(jsonReport.diagnostic, /received status 200/u);
    assert.match(jsonReport.diagnostic, /received response body bytes/u);
    assert.match(jsonReport.diagnostic, /received a parsed observation/u);

    const jsonEvidence = JSON.parse(readFileSync(
      join(root, 'captures', 'module-closed-real-json-empty-body-shape-turn-1-client.json'),
      'utf8',
    ));
    assert.deepEqual(jsonEvidence.observation.body, jsonBody);
    assert.equal(jsonEvidence.parse_diagnostic, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase dispatches the gemini unknown-tool correction and executes the declared echo exactly once', async () => {
  const root = tempEvidenceRoot();
  try {
    const fixture = loadCase('gemini-unknown-tool-correction-json');
    fixture.case_id = 'module-unknown-tool-correction-slice-b';
    // The native Gemini wire carries its key in the x-goog-api-key header.
    const geminiHeaders = { ...fixture.client_request.headers, 'x-goog-api-key': TEST_PROVIDER_AUTH };
    fixture.client_request.headers = geminiHeaders;
    for (const turn of fixture.turns) {
      if (turn.client_request) turn.client_request.headers = geminiHeaders;
    }
    const providerPath = fixture.expected_provider.paths[0];
    // The in-process pass-through serves the exact client bytes, so the later
    // turn bodies are the fixture's declared provider body plus the client
    // envelope it is cloned from (for example a `stream` flag).
    const turnBody = (index) => ({ ...fixture.turns[index].client_request.body, contents: fixture.turns[index].expected_provider_exact.contents });
    fixture.turns[1].expected_provider_exact = turnBody(1);
    fixture.turns[2].expected_provider_exact = turnBody(2);
    const mock = createMock(fixture, {
      wireAdapter: {
        provider_path: [providerPath, providerPath, providerPath],
        provider_request_exact: [
          fixture.client_request.body,
          fixture.turns[1].expected_provider_exact,
          fixture.turns[2].expected_provider_exact,
        ],
      },
    });
    const report = await runCase({
      fixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(report.status, 'passed', report.diagnostic);
    assert.deepEqual(mock.calls.map((call) => call.turn_index), [0, 1, 2]);
    assert.equal(report.turn_results.length, 3);

    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.ok(toolExecution, 'tool execution observation must be present');
    assert.equal(toolExecution.consumer, 'unknown-tool-correction');
    assert.deepEqual(
      toolExecution.executions.map((entry) => [entry.id, entry.name, entry.output]),
      [['call_corrected_1', 'echo', 'corrected']],
    );

    // Turn 2 carries the client-authored error for the observable unknown id/name,
    // and Turn 3 carries the real echo result. The undeclared call never runs.
    const errorTurn = JSON.parse(mock.calls[1].body);
    const errorResponse = errorTurn.contents[2].parts[0].functionResponse;
    assert.equal(errorResponse.id, 'call_unknown_1');
    assert.equal(errorResponse.name, 'outside_declared');
    assert.deepEqual(errorResponse.response, { error: { code: 'unknown_tool', message: 'unknown tool outside_declared' } });
    const finalTurn = JSON.parse(mock.calls[2].body);
    const finalResponse = finalTurn.contents
      .flatMap((entry) => entry.parts ?? [])
      .map((part) => part.functionResponse)
      .find((response) => response?.id === 'call_corrected_1');
    assert.equal(finalResponse?.name, 'echo');
    assert.equal(finalResponse?.response?.output, 'corrected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function geminiEchoLineResultFixture(caseId) {
  const fixture = loadCase('gemini-native-root-fidelity-relay-json');
  fixture.case_id = caseId;
  // The native Gemini wire carries its key in the x-goog-api-key header.
  const geminiHeaders = { ...fixture.client_request.headers, 'x-goog-api-key': TEST_PROVIDER_AUTH };
  fixture.client_request.headers = geminiHeaders;
  for (const turn of fixture.turns) {
    if (turn.client_request) turn.client_request.headers = geminiHeaders;
  }
  return fixture;
}

test('runCase dispatches the gemini echo-line-result consumer once and sends the structured result', async () => {
  const root = tempEvidenceRoot();
  try {
    const fixture = geminiEchoLineResultFixture('module-echo-line-result-slice-b');
    const providerPath = fixture.expected_provider.paths[0];
    fixture.turns[1].expected_provider_exact = { ...fixture.turns[1].client_request.body, contents: fixture.turns[1].expected_provider_exact.contents };
    const mock = createMock(fixture, {
      wireAdapter: {
        provider_path: [providerPath, providerPath],
        provider_request_exact: [fixture.client_request.body, fixture.turns[1].expected_provider_exact],
      },
    });
    const report = await runCase({
      fixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(report.status, 'passed', report.diagnostic);
    assert.deepEqual(mock.calls.map((call) => call.turn_index), [0, 1]);

    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.ok(toolExecution, 'tool execution observation must be present');
    assert.equal(toolExecution.consumer, 'echo-line-result');
    assert.deepEqual(toolExecution.executions, [{
      id: undefined,
      name: 'echo',
      type: 'functionCall',
      arguments: { message: 'native-tool-result' },
      output: { output: 'native-tool-result\n', exitCode: 0 },
    }]);

    // The request actually sent to the provider carries the structured result
    // and keeps the absent-role attachment wrapper.
    const finalTurn = JSON.parse(mock.calls[1].body);
    const finalResponse = finalTurn.contents.flatMap((entry) => entry.parts ?? []).map((part) => part.functionResponse).find((response) => response?.name === 'echo');
    assert.deepEqual(finalResponse.response, { output: 'native-tool-result\n', exitCode: 0 });
    assert.equal(Object.prototype.hasOwnProperty.call(finalTurn.contents[2], 'role'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase stops the echo-line-result follow-up on an execution/expected-output mismatch', async () => {
  const root = tempEvidenceRoot();
  try {
    const fixture = geminiEchoLineResultFixture('module-echo-line-result-mismatch');
    fixture.tool_followup.expected_output = { output: 'wrong\n', exitCode: 0 };
    const providerPath = fixture.expected_provider.paths[0];
    const mock = createMock(fixture, {
      wireAdapter: { provider_path: [providerPath], provider_request_exact: [fixture.client_request.body] },
    });
    const report = await runCase({
      fixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(report.status, 'failed');
    assert.match(report.diagnostic, /tool_followup: tool result mismatch/u);
    // The receipt survives the mismatch, and no follow-up request is sent.
    assert.equal(mock.calls.length, 1);
    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.deepEqual(toolExecution.executions[0].output, { output: 'native-tool-result\n', exitCode: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function localNamespaceMockFixture() {
  const namespaceTool = {
    type: 'namespace',
    name: 'collaboration',
    tools: [{
      type: 'function',
      name: 'spawn_agent',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }],
  };
  const headers = { 'content-type': 'application/json', authorization: TEST_PROVIDER_AUTH };
  const toolCall = { type: 'function_call', call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ message: 'do work' }) };
  return {
    schema_version: 1,
    case_id: 'module-local-namespace-mock-slice-b',
    cell: { entry_protocol: 'responses', provider_protocol: 'responses', transport: 'json', mode: 'direct' },
    client_request: { method: 'POST', path: '/v1/responses', headers, body: { model: 'chat-model', input: 'go', tools: [namespaceTool] } },
    expected_provider: {
      paths: ['/v1/responses'],
      method: 'POST',
      auth_required: true,
      body_must: { model: 'chat-model', 'tools.0.type': 'namespace', 'tools.0.name': 'collaboration' },
      body_must_not: ['routecodex_internal', 'metadata_center', 'debug_snapshot'],
      exact: null,
    },
    upstream_response: {
      protocol: 'responses',
      mode: 'json',
      status: 200,
      content_type: 'application/json',
      body: { id: 'resp_ns', object: 'response', status: 'completed', output: [{ id: 'fc_ns', ...toolCall }] },
    },
    expected_client: { transport: 'complete', status: 200, body_must: { status: 'completed' }, body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'], semantic_terminal_required: true },
    assertions: { provider_attempt_count: 1, probe_attempts_may_occur: true, no_control_leakage: true },
    source: { sha: 'bfaedf18301d02a423bd5422d22e41432d231ab8', files: [], tests: [] },
    turns: [
      { turn_id: 'call', purpose: 'local namespace call' },
      {
        turn_id: 'followup',
        purpose: 'readback follow-up',
        client_request: { method: 'POST', path: '/v1/responses', headers, body: { model: 'chat-model', input: [], stream: false } },
        upstream_response: { protocol: 'responses', mode: 'json', status: 200, content_type: 'application/json', body: { id: 'resp_ns_done', object: 'response', status: 'completed', output: [{ id: 'msg_done', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } },
        expected_client_must: { status: 'completed' },
      },
    ],
    tool_followup: {
      consumer: 'local-namespace-mock',
      side_effect: 'exclusive-local-file',
      binding: { namespace: 'collaboration', name: 'spawn_agent', type: 'function' },
      input: { message: 'do work' },
      expected_output: 'local namespace mock recorded: do work',
      assert_no_synthesized_tool_result: true,
      assert_declared_tool_binding_only: true,
      assert_tool_executed_once: true,
    },
  };
}

test('runCase dispatches the local namespace mock, writes one exclusive effect and a receipt, then follows up', async () => {
  const root = tempEvidenceRoot();
  try {
    const fixture = localNamespaceMockFixture();
    const mock = createMock(fixture);
    const report = await runCase({
      fixture,
      mock,
      rccUrl: 'http://127.0.0.1:0/',
      sendHttp: mock.sendHttp,
      evidenceRoot: root,
    });
    assert.equal(report.status, 'passed', report.diagnostic);
    assert.deepEqual(mock.calls.map((call) => call.turn_index), [0, 1]);

    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.ok(toolExecution, 'tool execution observation must be present');
    assert.equal(toolExecution.consumer, 'local-namespace-mock');
    assert.equal(toolExecution.executions[0].output, 'local namespace mock recorded: do work');

    const effect = JSON.parse(readFileSync(join(root, 'captures', `${fixture.case_id}-local-namespace-mock-effect.json`), 'utf8'));
    assert.deepEqual(effect, { call_id: 'call_ns_1', namespace: 'collaboration', name: 'spawn_agent', arguments: { message: 'do work' } });
    const receipt = JSON.parse(readFileSync(join(root, 'captures', `${fixture.case_id}-local-namespace-mock-execution.json`), 'utf8'));
    assert.equal(receipt.operation, 'exclusive-local-file');
    assert.equal(receipt.actual_output, 'local namespace mock recorded: do work');
    assert.deepEqual(receipt.observed_call, { call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', type: 'function_call', raw_arguments: JSON.stringify({ message: 'do work' }) });

    const followup = JSON.parse(mock.calls[1].body);
    assert.deepEqual(followup.input.slice(-2), [
      { type: 'function_call', call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ message: 'do work' }) },
      { type: 'function_call_output', call_id: 'call_ns_1', output: 'local namespace mock recorded: do work' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
