import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runCase } from './case-runner.mjs';
import {
  createMock,
  simpleFixture,
  tempEvidenceRoot,
  TEST_PROVIDER_AUTH,
} from './case-runner-test-support.mjs';

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
