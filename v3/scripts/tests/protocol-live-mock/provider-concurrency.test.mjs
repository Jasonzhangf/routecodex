import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectProviderConcurrencyEvidence,
  isProviderConcurrencyReplay,
  runProviderConcurrencyReplay,
} from './provider-concurrency.mjs';

const HOLDER_BODY = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp-held","status":"in_progress","output":[]}}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_held","delta":"held response released"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp-held","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":3,"total_tokens":4}}}',
  '',
].join('\n');

const RECOVERED_BODY = HOLDER_BODY.replaceAll('held response released', 'recovered response')
  .replaceAll('resp-held', 'resp-recovered')
  .replaceAll('msg_held', 'msg_recovered');

function heldFixture(overrides = {}) {
  return {
    case_id: 'issue-745f6e9-provider-concurrency-all-busy-direct',
    cell: {
      entry_protocol: 'responses',
      provider_protocol: 'responses',
      transport: 'sse',
      mode: 'direct',
    },
    runtime_setup: {
      provider_id: 'mock-responses',
      model: 'mock.responses-model',
      wire_model: 'responses-model',
      candidate_ids: ['mock-responses/mock.responses-model'],
      process: 'direct',
    },
    client_request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'session-id': 'holder', 'thread-id': 'holder' },
      body: { model: 'mock.responses-model', input: 'hold one', stream: true },
    },
    expected_provider: {
      paths: ['/v1/responses'],
      method: 'POST',
      auth_required: true,
      body_must: { model: 'responses-model', stream: true },
      exact: null,
    },
    expected_client: {
      transport: 'complete',
      status: 200,
      body_must: { text: 'held response released', status: 'completed' },
      body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
      semantic_terminal_required: true,
    },
    request_independence_replay: {
      kind: 'provider_request_independence',
      shape: 'held_concurrent_requests',
      concurrent_client_requests: [
        {
          method: 'POST',
          path: '/v1/responses',
          headers: { 'content-type': 'application/json', 'session-id': 'independent-2', 'thread-id': 'independent-2' },
          body: { model: 'mock.responses-model', input: 'hold two', stream: true },
        },
        {
          method: 'POST',
          path: '/v1/responses',
          headers: { 'content-type': 'application/json', 'session-id': 'independent-3', 'thread-id': 'independent-3' },
          body: { model: 'mock.responses-model', input: 'hold three', stream: true },
        },
      ],
      expected_concurrent_client: {
        transport: 'complete',
        status: 200,
        body_must: { text: 'held response released', status: 'completed' },
        body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
        semantic_terminal_required: true,
      },
      expected_upstream_business_sends: 3,
      typed_error_codes_must_not: ['provider_concurrency_busy', 'selected_target_exhausted'],
    },
    assertions: { provider_attempt_count: 3, probe_attempts_may_occur: true, no_control_leakage: true },
    ...overrides,
  };
}

function failureFixture(overrides = {}) {
  return {
    ...heldFixture(),
    case_id: 'issue-745f6e9-provider-concurrency-mixed-exclusion-direct',
    runtime_setup: {
      provider_id: 'mock-responses-primary',
      model: 'mock.responses-model',
      wire_model: 'responses-model',
      candidate_ids: [
        'mock-responses-primary/mock.responses-model',
        'mock-responses-recovered/mock.responses-model',
      ],
      process: 'direct',
      health: { enabled: true, failure_threshold: 1, cooldown_ms: 60000 },
    },
    expected_client: {
      transport: 'complete',
      status: 200,
      body_must: { text: 'held response released', status: 'completed' },
      body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
      semantic_terminal_required: true,
    },
    request_independence_replay: {
      kind: 'provider_request_independence',
      shape: 'failure_isolation',
      failed_client_request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json', 'session-id': 'failed', 'thread-id': 'failed' },
        body: { model: 'mock.responses-model', input: 'fail once', stream: true },
      },
      expected_failed_client: {
        transport: 'complete',
        status: 200,
        body_must: { text: 'recovered response', status: 'completed' },
        body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
        semantic_terminal_required: true,
      },
      post_recovery_client_request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json', 'session-id': 'post-recovery', 'thread-id': 'post-recovery' },
        body: { model: 'mock.responses-model', input: 'after recovery', stream: true },
      },
      expected_post_recovery_client: {
        transport: 'complete',
        status: 200,
        body_must: { text: 'recovered response', status: 'completed' },
        body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
        semantic_terminal_required: true,
      },
      failure_isolation: {
        failed_provider_id: 'mock-responses-primary',
        recovered_provider_id: 'mock-responses-recovered',
        expected_provider_status: 500,
        expected_action: 'switch_provider',
        expected_holder_business_sends: 1,
        expected_failed_business_sends: 1,
        expected_recovery_business_sends: 2,
      },
      typed_error_codes_must_not: ['provider_concurrency_busy'],
    },
    assertions: { provider_attempt_count: 4, probe_attempts_may_occur: true, no_control_leakage: true },
    ...overrides,
  };
}

function completeClient(bodyText = HOLDER_BODY) {
  return {
    status: 200,
    status_text: 'OK',
    headers: { 'content-type': 'text/event-stream' },
    bodyText,
    response_ended: true,
    complete: true,
    closed: false,
    error: null,
    error_detail: null,
    elapsed_ms: 20,
  };
}

function heldHarness({ rejectBarrierAfter = null } = {}) {
  const captures = [];
  let released = 0;
  const mock = {
    setActiveCase() {},
    getCaptures() { return captures; },
    async waitForHeldCount(_caseId, count) {
      if (rejectBarrierAfter !== null && count > rejectBarrierAfter) {
        const error = new Error('mock_hold_timeout: independent request did not reach upstream');
        error.code = 'mock_hold_timeout';
        throw error;
      }
      return { held: count, requested: count };
    },
    async releaseHeldAll() {
      released = captures.length;
      return released;
    },
    heldCount() { return captures.length; },
  };
  const sendHttp = async (url, options) => {
    if (url.endsWith('/_routecodex/debug/status')) {
      return { status: 200, body: { status: 'ok' }, bodyText: '{"status":"ok"}' };
    }
    const body = JSON.parse(options.body);
    captures.push({
      attempt_kind: 'business',
      captured_at_epoch_ms: Date.now(),
      method: 'POST',
      path: '/v1/responses',
      headers: { authorization: 'Bearer holder-token' },
      body: { ...body, model: 'responses-model' },
      response_script: { mode: 'sse', status: 200 },
    });
    return completeClient();
  };
  return { mock, sendHttp, get released() { return released; } };
}

function failureHarness({ failPayloadAtClient = false } = {}) {
  const captures = [];
  let released = 0;
  const mock = {
    setActiveCase() {},
    getCaptures() { return captures; },
    async waitForHeldCount() { return { held: 1, requested: 1 }; },
    async releaseHeldAll() { released += 1; return 1; },
  };
  const sendHttp = async (url, options) => {
    if (url.endsWith('/_routecodex/debug/status')) {
      return { status: 200, body: { status: 'ok' }, bodyText: '{"status":"ok"}' };
    }
    if (url.endsWith('/_routecodex/health/cooldown-pool')) {
      const entries = captures.some((capture) => capture.response_script.status === 500)
        ? [{
            provider_id: 'mock-responses-primary',
            interface_id: 'default',
            auth_alias: 'key1',
            model_id: null,
            kind: 'auth_key',
            state: 'cooldown',
          }]
        : [];
      return { status: 200, body: { entries }, bodyText: JSON.stringify({ entries }) };
    }
    const body = JSON.parse(options.body);
    if (body.input === 'hold one') {
      captures.push(businessCapture('holder-token', body, 200));
      return completeClient();
    }
    if (body.input === 'fail once') {
      captures.push(businessCapture('holder-token', body, 500));
      captures.push(businessCapture('recovered-token', body, 200));
      return completeClient(failPayloadAtClient ? RECOVERED_BODY.concat('\nevent: error\ndata: {"error":{"code":"provider_error"}}\n\n') : RECOVERED_BODY);
    }
    if (body.input === 'after recovery') {
      captures.push(businessCapture('recovered-token', body, 200));
      return completeClient(RECOVERED_BODY);
    }
    throw new Error(`unexpected request ${body.input}`);
  };
  return { mock, sendHttp, get released() { return released; } };
}

function businessCapture(token, body, status) {
  return {
    attempt_kind: 'business',
    captured_at_epoch_ms: Date.now(),
    method: 'POST',
    path: '/v1/responses',
    headers: { authorization: `Bearer ${token}` },
    body: { ...body, model: 'responses-model' },
    response_script: { mode: 'sse', status },
  };
}

test('held replay proves every independent request reaches the upstream before release', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-independence-held-'));
  const harness = heldHarness();
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: heldFixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'passed', result.diagnostic);
    assert.equal(result.observations.provider_concurrency.arrival_barrier_reached, true);
    assert.equal(result.observations.provider_concurrency.held_at_barrier, 3);
    assert.equal(result.observations.provider_concurrency.upstream_business_sends, 3);
    assert.equal(harness.released, 3);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('held replay fails when a concurrent request never reaches the upstream', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-independence-barrier-'));
  const harness = heldHarness({ rejectBarrierAfter: 2 });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: heldFixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.diagnostic, /arrival barrier failed|reached the upstream before release/);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('failure replay isolates a real provider error and returns recovered business responses', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-independence-failure-'));
  const harness = failureHarness();
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: failureFixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'passed', result.diagnostic);
    const observed = result.observations.provider_concurrency;
    assert.equal(observed.failed_provider_status, 500);
    assert.equal(observed.failed_provider_business_sends, 1);
    assert.equal(observed.recovered_business_sends, 2);
    assert.equal(observed.upstream_business_sends, 4);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('failure replay rejects a provider error payload leaked to the client', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-independence-leak-'));
  const harness = failureHarness({ failPayloadAtClient: true });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: failureFixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.diagnostic, /provider-failure recovery:/);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

function writeRecords(root, rows) {
  const path = join(root, 'records.jsonl');
  writeFileSync(path, rows.map((row) => `${JSON.stringify({ schema_version: 1, row })}\n`).join(''));
  return path;
}

function writeTypedEvidence(root, requestId, { status = 500, action = 'switch_provider' } = {}) {
  const sampleRoot = join(root, 'home', '.rcc', 'codex-samples');
  const sampleDir = join(sampleRoot, 'openai-responses', 'ports', '12345', requestId);
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(join(sampleDir, 'provider-failed-attempts.json'), `${JSON.stringify({
    object: 'routecodex.v3.provider_failed_attempt_evidence',
    request_id: requestId,
    attempts: [{
      provider_id: 'mock-responses-primary',
      interface_id: 'default',
      status,
      action,
    }],
    terminal_source: null,
  }, null, 2)}\n`);
  return sampleRoot;
}

function row({ requestKey, requestId, eventType = 'request.route_selected', mode = 'direct', started = 100 }) {
  return {
    request_key: requestKey,
    event_type: eventType,
    scope: { port: 12345 },
    started_epoch_ms: started,
    updated_epoch_ms: started + 5,
    finished_epoch_ms: eventType === 'request.route_selected' ? null : started + 5,
    attempts: 1,
    meta: { request_id: requestId, endpoint: '/v1/responses', execution_mode: mode },
  };
}

test('held evidence collection accepts mode-only success and rejects a terminal failure row', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-independence-collect-'));
  try {
    const storePath = writeRecords(root, [
      row({ requestKey: '12345:req-1', requestId: 'req-1', started: 100 }),
      row({ requestKey: '12345:req-1', requestId: 'req-1', eventType: 'request.completed', started: 100 }),
      row({ requestKey: '12345:req-2', requestId: 'req-2', started: 101 }),
      row({ requestKey: '12345:req-2', requestId: 'req-2', eventType: 'request.completed', started: 101 }),
      row({ requestKey: '12345:req-3', requestId: 'req-3', started: 102 }),
      row({ requestKey: '12345:req-3', requestId: 'req-3', eventType: 'request.completed', started: 102 }),
    ]);
    const result = collectProviderConcurrencyEvidence({
      fixture: heldFixture({
        request_independence_replay: {
          ...heldFixture().request_independence_replay,
          expected_upstream_business_sends: 2,
        },
      }),
      caseRoot: root,
      storePath,
      sampleRoot: null,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 99, settled_epoch_ms: 110 },
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'pass', result.findings.join('\n'));
    assert.equal(result.actual_mode, 'direct');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure evidence collection binds typed provider status and recovery instead of a client failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-independence-typed-'));
  try {
    const requestId = 'req-recovered';
  const failedRequestId = 'req-failed';
    const storePath = writeRecords(root, [
      row({ requestKey: `12345:${requestId}`, requestId, started: 100 }),
      row({ requestKey: `12345:${requestId}`, requestId, eventType: 'request.completed', started: 100 }),
    row({ requestKey: `12345:${failedRequestId}`, requestId: failedRequestId, started: 101 }),
    row({ requestKey: `12345:${failedRequestId}`, requestId: failedRequestId, eventType: 'request.completed', started: 101 }),
    ]);
    const sampleRoot = writeTypedEvidence(root, failedRequestId);
    const result = collectProviderConcurrencyEvidence({
      fixture: failureFixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: {
        started_epoch_ms: 99,
        settled_epoch_ms: 110,
        failed_started_epoch_ms: 101,
        failed_settled_epoch_ms: 105,
      },
      collectionPhase: 'post_stop_complete',
    });
    assert.equal(result.status, 'pass', result.findings.join('\n'));
    assert.equal(result.typed_source.attempts[0].status, 500);
    assert.equal(result.typed_source.attempts[0].action, 'switch_provider');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixtures are detected by the historical replay predicate', () => {
  assert.equal(isProviderConcurrencyReplay(heldFixture()), true);
  assert.equal(isProviderConcurrencyReplay({ request_independence_replay: { kind: 'other' } }), false);
});
