import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  collectProviderConcurrencyEvidence,
  runProviderConcurrencyReplay,
} from './provider-concurrency.mjs';

const DIRECT_CANDIDATE_A = 'mock-responses-busy/mock.responses-model';
const DIRECT_CANDIDATE_E = 'mock-responses-excluded/mock.responses-model';
const DIRECT_TOKEN_A = 'fake-loopback-token-mock-responses-busy';
const DIRECT_TOKEN_E = 'fake-loopback-token-mock-responses-excluded';

function requestIndependenceFixture() {
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
      candidate_ids: [DIRECT_CANDIDATE_A],
      candidate_tiers: [[DIRECT_CANDIDATE_A]],
      provider_concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 1000,
        staleLeaseMs: 300000,
      },
      attempt_store: { residence_timeout_ms: 30000 },
    },
    client_request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'session-id': 'holder', 'thread-id': 'holder' },
      body: { model: 'mock.responses-model', input: '[holder] hold A', stream: true },
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
      semantic_terminal_required: true,
    },
    upstream_response: {
      protocol: 'responses',
      mode: 'fault',
      status: 200,
      content_type: 'text/event-stream',
      fault: 'hold-open-controlled',
      attempts: [
        {
          kind: 'fault',
          fault: 'hold-open-controlled',
          when: { input_contains: '[holder]' },
          sse_events: [
            { event: 'response.created', data: { type: 'response.created', response: { id: 'resp-held', status: 'in_progress', output: [] } } },
            { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_held', delta: 'held response released' } },
            { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp-held', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'held response released' }] }], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 } } } },
          ],
        },
        {
          kind: 'sse',
          when: { input_contains: '[sibling-' },
          status: 200,
          content_type: 'text/event-stream',
          sse_events: [
            { event: 'response.created', data: { type: 'response.created', response: { id: 'resp-sibling', status: 'in_progress', output: [] } } },
            { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_sibling', delta: 'held response released' } },
            { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp-sibling', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'held response released' }] }], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 } } } },
          ],
        },
      ],
    },
    request_independence_replay: {
      kind: 'bounded_capacity_wait',
      sibling_client_requests: [
        {
          id: 'sibling-b',
          client_request: {
            method: 'POST',
            path: '/v1/responses',
            headers: { 'content-type': 'application/json', 'session-id': 'sibling-b', 'thread-id': 'sibling-b' },
            body: { model: 'mock.responses-model', input: '[sibling-b] wait for capacity', stream: true },
          },
          expected_client: {
            transport: 'complete',
            status: 200,
            body_must: { text: 'held response released', status: 'completed' },
            semantic_terminal_required: true,
          },
        },
        {
          id: 'sibling-c',
          client_request: {
            method: 'POST',
            path: '/v1/responses',
            headers: { 'content-type': 'application/json', 'session-id': 'sibling-c', 'thread-id': 'sibling-c' },
            body: { model: 'mock.responses-model', input: '[sibling-c] wait for capacity', stream: true },
          },
          expected_client: {
            transport: 'complete',
            status: 200,
            body_must: { text: 'held response released', status: 'completed' },
            semantic_terminal_required: true,
          },
        },
      ],
      pending_before_release: ['sibling-b', 'sibling-c'],
      completed_before_release: [],
      expected_peak_business_in_flight: { [DIRECT_CANDIDATE_A]: 1 },
      expected_business_sends: [
        { request_id: 'holder', candidate_id: DIRECT_CANDIDATE_A, outcome: 'success', status: 200 },
        { request_id: 'sibling-b', candidate_id: DIRECT_CANDIDATE_A, outcome: 'success', status: 200 },
        { request_id: 'sibling-c', candidate_id: DIRECT_CANDIDATE_A, outcome: 'success', status: 200 },
      ],
      failed_attempt: null,
      forbidden_client_content: ['provider_error', 'internal_error', 'routecodex_internal', 'provider_concurrency_busy'],
    },
    assertions: { provider_attempt_count: 3, probe_attempts_may_occur: true, no_control_leakage: true },
  };
}

function mixedRequestIndependenceFixture() {
  const value = requestIndependenceFixture();
  value.case_id = 'issue-745f6e9-provider-concurrency-mixed-exclusion-direct';
  value.runtime_setup = {
    ...value.runtime_setup,
    candidate_ids: [DIRECT_CANDIDATE_A, DIRECT_CANDIDATE_E],
    candidate_tiers: [[DIRECT_CANDIDATE_A], [DIRECT_CANDIDATE_E]],
  };
  value.request_independence_replay = {
    kind: 'request_local_failure_isolation',
    sibling_client_requests: [
      {
        id: 'sibling-b',
        client_request: {
          method: 'POST',
          path: '/v1/responses',
          headers: { 'content-type': 'application/json', 'session-id': 'sibling-b', 'thread-id': 'sibling-b' },
          body: { model: 'mock.responses-model', input: '[sibling-b] fail E then recover A', stream: true },
        },
        expected_client: {
          transport: 'complete',
          status: 200,
          body_must: { text: 'sibling B recovered through A', status: 'completed' },
          semantic_terminal_required: true,
        },
      },
      {
        id: 'sibling-c',
        client_request: {
          method: 'POST',
          path: '/v1/responses',
          headers: { 'content-type': 'application/json', 'session-id': 'sibling-c', 'thread-id': 'sibling-c' },
          body: { model: 'mock.responses-model', input: '[sibling-c] complete through E', stream: true },
        },
        expected_client: {
          transport: 'complete',
          status: 200,
          body_must: { text: 'sibling C completed through E', status: 'completed' },
          semantic_terminal_required: true,
        },
      },
    ],
    pending_before_release: ['sibling-b'],
    completed_before_release: ['sibling-c'],
    expected_peak_business_in_flight: { [DIRECT_CANDIDATE_A]: 1, [DIRECT_CANDIDATE_E]: 1 },
    expected_business_sends: [
      { request_id: 'holder', candidate_id: DIRECT_CANDIDATE_A, outcome: 'success', status: 200 },
      { request_id: 'sibling-b', candidate_id: DIRECT_CANDIDATE_E, outcome: 'failure', status: 503 },
      { request_id: 'sibling-c', candidate_id: DIRECT_CANDIDATE_E, outcome: 'success', status: 200 },
      { request_id: 'sibling-b', candidate_id: DIRECT_CANDIDATE_A, outcome: 'success', status: 200 },
    ],
    failed_attempt: {
      request_id: 'sibling-b',
      candidate_id: DIRECT_CANDIDATE_E,
      http_status: 503,
      body_contains: 'controlled provider 503',
      typed_error_code: 'provider_http_503',
      client_visible: false,
      retry_before_release: false,
    },
    forbidden_client_content: ['controlled provider 503', 'provider_error', 'internal_error', 'routecodex_internal'],
  };
  value.assertions = { ...value.assertions, provider_attempt_count: 4 };
  return value;
}

function fakeRequestIndependenceHarness({
  kind = 'bounded_capacity_wait',
  extraConcurrentCapture = false,
  completeSiblingBeforeRelease = false,
  extraERetryBeforeRelease = false,
  leakProviderError = false,
  cancellationBlocksSibling = false,
} = {}) {
  const fixtureValue = kind === 'request_local_failure_isolation'
    ? mixedRequestIndependenceFixture()
    : requestIndependenceFixture();
  const captures = [];
  const waiters = new Set();
  const clientControls = new Map();
  let releaseCount = 0;
  let resolveHolder;
  let resolveB;

  function addCapture(label, candidateId, started = Date.now(), status = 200, bodyText = '') {
    const providerId = candidateId.split('/')[0];
    const capture = {
      attempt_kind: 'business',
      case_id: fixtureValue.case_id,
      turn: 0,
      method: 'POST',
      path: '/v1/responses',
      candidate_id: candidateId,
      provider_id: providerId,
      headers: { authorization: `Bearer ${candidateId.startsWith('mock-responses-busy') ? DIRECT_TOKEN_A : DIRECT_TOKEN_E}` },
      body: { model: 'responses-model', input: `[${label}]`, stream: true },
      response_script: { status, body: bodyText || null },
      captured_at_epoch_ms: started,
      business_started_epoch_ms: started,
      business_finished_epoch_ms: null,
    };
    captures.push(capture);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(capture, captures)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(cloneJSON(capture));
      }
    }
    return capture;
  }

  function finishCapture(capture) {
    capture.business_finished_epoch_ms = Date.now();
  }

  const mock = {
    async setActiveCase() {},
    getCaptures() { return cloneJSON(captures); },
    async waitForHeld() {},
    async waitForCapture(predicate, timeoutMs = 1000) {
      const existing = captures.find((capture) => predicate(capture, captures));
      if (existing) return cloneJSON(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error('capture wait timed out'));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async releaseHeld() {
      releaseCount += 1;
      const holderCapture = captures.find((capture) => capture.body.input === '[holder]');
      if (holderCapture) finishCapture(holderCapture);
      resolveHolder?.();
      if (kind === 'request_local_failure_isolation') {
        void (async () => {
          await delay(5);
          const recovery = addCapture('sibling-b', DIRECT_CANDIDATE_A, Date.now(), 200, 'sibling B recovered through A');
          finishCapture(recovery);
          resolveB?.();
        })();
      } else {
        void (async () => {
          await delay(5);
          const born = addCapture('sibling-b', DIRECT_CANDIDATE_A, Date.now(), 200, 'held response released');
          finishCapture(born);
          clientControls.get('sibling-b')?.resolve(completeClient(HOLDER_BODY));
          await delay(5);
          const c = addCapture('sibling-c', DIRECT_CANDIDATE_A, Date.now(), 200, 'held response released');
          finishCapture(c);
          clientControls.get('sibling-c')?.resolve(completeClient(HOLDER_BODY));
        })();
      }
      return 1;
    },
  };

  const sendHttp = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = String(body.input ?? '');
    if (input.includes('[holder]')) {
      const capture = addCapture('holder', DIRECT_CANDIDATE_A, Date.now(), 200, 'held response released');
      return new Promise((resolve) => {
        resolveHolder = () => {
          finishCapture(capture);
          resolve(completeClient(HOLDER_BODY));
        };
      });
    }
    if (input.includes('[sibling-b]')) {
      if (kind === 'request_local_failure_isolation') {
        const failed = addCapture('sibling-b', DIRECT_CANDIDATE_E, Date.now(), 503, '{"error":{"message":"controlled provider 503"}}');
        finishCapture(failed);
        if (extraERetryBeforeRelease) {
          const retry = addCapture('sibling-b', DIRECT_CANDIDATE_E, Date.now(), 503, '{"error":{"message":"controlled provider 503"}}');
          finishCapture(retry);
        }
        return new Promise((resolve) => {
          resolveB = () => resolve(completeClient(mixedSuccessBody('sibling B recovered through A')));
        });
      }
      return new Promise((resolve, reject) => {
        clientControls.set('sibling-b', {
          resolve,
          reject(error) {
            reject(error);
          },
        });
        if (completeSiblingBeforeRelease) {
          clientControls.get('sibling-b').resolve(completeClient(HOLDER_BODY));
        }
      });
    }
    if (input.includes('[sibling-c]')) {
      if (kind === 'request_local_failure_isolation') {
        const capture = addCapture('sibling-c', DIRECT_CANDIDATE_E, Date.now(), 200, 'sibling C completed through E');
        finishCapture(capture);
        return completeClient(mixedSuccessBody('sibling C completed through E'));
      }
      return new Promise((resolve, reject) => {
        clientControls.set('sibling-c', {
          resolve,
          reject(error) {
            reject(error);
          },
        });
      });
    }
    throw new Error(`unexpected request input: ${input}`);
  };

  if (extraConcurrentCapture) {
    const extra = addCapture('holder', DIRECT_CANDIDATE_A, Date.now(), 200, 'held response released');
    void extra;
  }

  return {
    fixture: fixtureValue,
    mock,
    sendHttp,
    candidateIdentityReceipts: [
      { candidate_id: DIRECT_CANDIDATE_A, provider_id: 'mock-responses-busy', model: 'mock.responses-model', auth_token: DIRECT_TOKEN_A },
      { candidate_id: DIRECT_CANDIDATE_E, provider_id: 'mock-responses-excluded', model: 'mock.responses-model', auth_token: DIRECT_TOKEN_E },
    ],
    async cancelRequest(id) {
      const control = clientControls.get(id);
      if (!control) throw new Error(`no client control for ${id}`);
      const error = new Error('request cancelled');
      error.code = 'ABORT_ERR';
      control.reject(error);
      if (cancellationBlocksSibling) {
        clientControls.get('sibling-c')?.resolve(CLOSED_BY_PRODUCT);
      }
    },
    get releaseCount() { return releaseCount; },
    leakProviderError,
  };
}

function mixedSuccessBody(textValue) {
  return HOLDER_BODY.replaceAll('held response released', textValue)
    .replaceAll('resp-held', 'resp-mixed')
    .replaceAll('msg_held', 'msg_mixed');
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

async function runNewReplay(harness, options = {}) {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-new-'));
  try {
    return {
      result: await runProviderConcurrencyReplay({
        fixture: harness.fixture,
        mock: harness.mock,
        rccUrl: 'http://127.0.0.1:12345',
        sendHttp: harness.sendHttp,
        evidenceRoot,
        timeoutMs: 1000,
        pendingObservationMs: 20,
        candidateIdentityReceipts: harness.candidateIdentityReceipts,
        ...options,
      }),
      harness,
    };
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

test('bounded capacity replay keeps two siblings pending, serializes one identity, and completes all three clients', async () => {
  const harness = fakeRequestIndependenceHarness();
  const { result } = await runNewReplay(harness);
  assert.equal(result.status, 'passed', result.diagnostic);
  assert.equal(result.observations.provider_concurrency.kind, 'bounded_capacity_wait');
  assert.deepEqual(result.observations.provider_concurrency.pending_before_release, ['sibling-b', 'sibling-c']);
  assert.equal(result.observations.provider_concurrency.client_results.length, 3);
  assert.deepEqual(result.observations.provider_concurrency.peak_business_in_flight, { [DIRECT_CANDIDATE_A]: 1 });
  assert.equal(harness.releaseCount, 1);
});

test('bounded capacity replay rejects a second concurrent business attempt on the limit-one identity', async () => {
  const harness = fakeRequestIndependenceHarness({ extraConcurrentCapture: true });
  const { result } = await runNewReplay(harness);
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /concurrent business attempt/i);
});

test('bounded capacity replay rejects false completion before the holder is released', async () => {
  const harness = fakeRequestIndependenceHarness({ completeSiblingBeforeRelease: true });
  const { result } = await runNewReplay(harness);
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /completed before release/i);
});

test('request-local failure isolation completes C through E, keeps B resident, and recovers B through A', async () => {
  const harness = fakeRequestIndependenceHarness({ kind: 'request_local_failure_isolation' });
  const { result } = await runNewReplay(harness);
  assert.equal(result.status, 'passed', result.diagnostic);
  assert.equal(result.observations.provider_concurrency.kind, 'request_local_failure_isolation');
  assert.deepEqual(result.observations.provider_concurrency.completed_before_release, ['sibling-c']);
  assert.deepEqual(result.observations.provider_concurrency.pending_before_release, ['sibling-b']);
  assert.equal(result.observations.provider_concurrency.failed_attempt.status, 503);
  assert.deepEqual(result.observations.provider_concurrency.peak_business_in_flight, {
    [DIRECT_CANDIDATE_A]: 1,
    [DIRECT_CANDIDATE_E]: 1,
  });
  assert.equal(harness.releaseCount, 1);
});

test('request-local failure isolation rejects an unauthorized E retry before release', async () => {
  const harness = fakeRequestIndependenceHarness({ kind: 'request_local_failure_isolation', extraERetryBeforeRelease: true });
  const { result } = await runNewReplay(harness);
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /retry|business send/i);
});

test('request-local failure isolation rejects leaking the internal 503 body to the client', async () => {
  const harness = fakeRequestIndependenceHarness({ kind: 'request_local_failure_isolation', leakProviderError: true });
  const { result } = await runNewReplay(harness, {
    clientResultOverride: {
      'sibling-b': completeClient('{"error":{"message":"controlled provider 503"}}'),
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /forbidden client content|controlled provider 503/i);
});

test('bounded capacity replay lets a surviving sibling complete after one pending request cancels', async () => {
  const harness = fakeRequestIndependenceHarness();
  const { result } = await runNewReplay(harness, {
    cancelRequestId: 'sibling-b',
    cancelRequest: harness.cancelRequest,
  });
  assert.equal(result.status, 'passed', result.diagnostic);
  assert.deepEqual(
    result.observations.provider_concurrency.cancellations.map((entry) => entry.request_id),
    ['sibling-b'],
  );
  assert.equal(result.observations.provider_concurrency.client_results.length, 3);
});

test('bounded capacity replay rejects cancellation of one request blocking a surviving sibling', async () => {
  const harness = fakeRequestIndependenceHarness({ cancellationBlocksSibling: true });
  const { result } = await runNewReplay(harness, {
    cancelRequestId: 'sibling-b',
    cancelRequest: harness.cancelRequest,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /sibling-c did not survive cancellation of sibling sibling-b/i);
});

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

const REUSE_BODY = HOLDER_BODY.replaceAll('held response released', 'capacity reused')
  .replaceAll('resp-held', 'resp-reused')
  .replaceAll('msg_held', 'msg_reused');

function fixture(overrides = {}) {
  return {
    case_id: 'issue-745f6e9-provider-concurrency-all-busy-direct',
    cell: {
      entry_protocol: 'responses',
      provider_protocol: 'responses',
      transport: 'sse',
      mode: 'direct',
    },
    client_request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'session-id': 'holder', 'thread-id': 'holder' },
      body: { model: 'mock.responses-model', input: 'hold', stream: true },
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
      semantic_terminal_required: true,
    },
    concurrency_replay: {
      kind: 'provider_concurrency_all_busy',
      exhaustion_client_request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json', 'session-id': 'exhausted', 'thread-id': 'exhausted' },
        body: { model: 'mock.responses-model', input: 'no-capacity', stream: true },
      },
      expected_exhaustion_client: {
        transport: 'closed',
        deadline_ms: 500,
        error_codes_must_not: ['ETIMEDOUT'],
      },
      typed_error_codes: ['provider_concurrency_busy'],
      upstream_business_sends: 1,
    },
    assertions: { provider_attempt_count: 1, probe_attempts_may_occur: true, no_control_leakage: true },
    ...overrides,
  };
}

function mixedFixture() {
  const value = fixture({
    case_id: 'issue-745f6e9-provider-concurrency-mixed-exclusion-direct',
    runtime_setup: {
      provider_id: 'mock-responses-busy',
      model: 'mock.responses-model',
      wire_model: 'responses-model',
      candidate_ids: [
        'mock-responses-busy/mock.responses-model',
        'mock-responses-excluded/mock.responses-model',
      ],
      provider_concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 60000,
        staleLeaseMs: 300000,
      },
    },
  });
  value.concurrency_replay = {
    ...value.concurrency_replay,
    shape: 'mixed_exclusion',
    expected_source_kind: 'target_pool_exhausted',
    expected_source_stage: null,
    expected_attempts_empty: true,
    capacity_reuse_client_request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'session-id': 'reuse', 'thread-id': 'reuse' },
      body: { model: 'mock.responses-model', input: 'reuse', stream: true },
    },
    expected_capacity_reuse_client: {
      transport: 'complete',
      status: 200,
      body_must: { text: 'capacity reused', status: 'completed' },
      semantic_terminal_required: true,
    },
    typed_error_codes: ['selected_target_exhausted'],
    typed_error_codes_must_not: ['provider_concurrency_busy'],
    mixed_exclusion: {
      excluded_provider_id: 'mock-responses-excluded',
      expected_holder_business_sends: 1,
      expected_reuse_business_sends: 1,
      expected_probe_sends: 1,
      expected_health_entry_count: 2,
      cooldown_identity: {
        interface_id: 'default',
        auth_alias: 'key1',
        kind: 'auth_key',
        duration_ms: 60000,
      },
    },
  };
  return value;
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
    elapsed_ms: 25,
  };
}

const MIXED_HEALTH_ENTRIES = [
  {
    provider_id: 'mock-responses-excluded',
    interface_id: 'default',
    auth_alias: 'key1',
    model_id: null,
    kind: 'auth_key',
    state: 'auth_key_cooldown',
  },
  {
    provider_id: 'mock-responses-excluded',
    interface_id: 'default',
    auth_alias: 'key1',
    model_id: null,
    kind: 'probe',
    state: 'waiting',
  },
];

function fakeMixedHarness() {
  let resolveHolder;
  let released = 0;
  const captures = [];
  const mock = {
    setActiveCase() {},
    getCaptures() { return captures; },
    async waitForHeld() {},
    async releaseHeld() {
      released += 1;
      resolveHolder?.(completeClient());
      return 1;
    },
  };
  const sendHttp = async (url, options) => {
    if (url.endsWith('/_routecodex/debug/status')) {
      return { status: 200, body: { status: 'ok' }, bodyText: '{"status":"ok"}' };
    }
    if (url.endsWith('/_routecodex/health/cooldown-pool/add')) {
      return { status: 200, body: { ok: true }, bodyText: '{"ok":true}' };
    }
    if (url.endsWith('/_routecodex/health/cooldown-pool')) {
      return {
        status: 200,
        body: { entries: MIXED_HEALTH_ENTRIES },
        bodyText: JSON.stringify({ entries: MIXED_HEALTH_ENTRIES }),
      };
    }
    const body = JSON.parse(options.body);
    if (body.input === 'hold') {
      captures.push({
        attempt_kind: 'business',
        captured_at_epoch_ms: Date.now(),
        case_id: mixedFixture().case_id,
        turn: 0,
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer holder-token' },
        body: { ...body, model: 'responses-model' },
      });
      return new Promise((resolve) => { resolveHolder = resolve; });
    }
    if (body.input === 'no-capacity') {
      captures.push({
        attempt_kind: 'business',
        captured_at_epoch_ms: Date.now(),
        case_id: mixedFixture().case_id,
        turn: 0,
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer excluded-token' },
        body: { model: 'responses-model', input: 'ping; reply pong' },
        raw_body: '{"model":"responses-model","input":"ping; reply pong"}',
      });
      return CLOSED_BY_PRODUCT;
    }
    if (body.input === 'reuse') {
      captures.push({
        attempt_kind: 'business',
        captured_at_epoch_ms: Date.now(),
        case_id: mixedFixture().case_id,
        turn: 0,
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer holder-token' },
        body: { ...body, model: 'responses-model' },
      });
      return completeClient(REUSE_BODY);
    }
    throw new Error(`unexpected mixed harness request: ${url} ${options.body}`);
  };
  return {
    mock,
    sendHttp,
    get released() { return released; },
  };
}

function fakeHarness({ secondClient, extraCapture = false } = {}) {
  let resolveHolder;
  let captures = [];
  let released = 0;
  const mock = {
    setActiveCase() {},
    getCaptures() { return captures; },
    async waitForHeld() {},
    async releaseHeld() {
      released += 1;
      resolveHolder?.(completeClient());
      return 1;
    },
  };
  const sendHttp = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.input === 'hold') {
      captures = [{
        attempt_kind: 'business',
        captured_at_epoch_ms: Date.now(),
        case_id: fixture().case_id,
        turn: 0,
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer fake-loopback-token' },
        body: { ...body, model: 'responses-model' },
      }];
      return new Promise((resolve) => { resolveHolder = resolve; });
    }
    if (extraCapture) {
      captures.push({
        attempt_kind: 'business',
        captured_at_epoch_ms: Date.now(),
        case_id: fixture().case_id,
        turn: 0,
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer fake-loopback-token' },
        body: { ...body, model: 'responses-model' },
      });
    }
    return secondClient;
  };
  return {
    mock,
    sendHttp,
    get released() { return released; },
  };
}

const CLOSED_BY_PRODUCT = {
  status: null,
  headers: {},
  bodyText: '',
  response_ended: false,
  complete: null,
  closed: true,
  error: 'socket hang up',
  error_detail: { code: 'ECONNRESET', message: 'socket hang up' },
  elapsed_ms: 20,
};

const KEEPALIVE_THEN_CLOSED_BY_PRODUCT = {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  bodyText: ':\n\n',
  response_ended: false,
  complete: false,
  closed: true,
  aborted: true,
  error: 'aborted',
  error_detail: { code: 'ECONNRESET', message: 'aborted' },
  elapsed_ms: 2,
};

const COMPLETE_ERROR_CHAIN = [
  'V3Error01SourceRaised',
  'V3Error02Classified',
  'V3Error03TargetLocalAction',
  'V3Error04TargetExhaustionDecision',
  'V3Error05ExecutionDecision',
  'V3Error06ClientProjected',
].map((node) => ({ node, state: 'observed' }));

function routeSelectedRow({ mode = 'direct', port = 12345, endpoint = '/v1/responses' } = {}) {
  return {
    request_key: `${port}:req-holder`,
    event_type: 'request.route_selected',
    scope: { port },
    started_epoch_ms: 90,
    updated_epoch_ms: 95,
    finished_epoch_ms: null,
    attempts: 0,
    meta: {
      request_id: 'req-holder',
      endpoint,
      execution_mode: mode,
    },
  };
}

function relayFailureRow({
  executionMode = 'relay',
  includeExecutionMode = true,
} = {}) {
  const meta = {
    request_id: 'req-exhausted',
    endpoint: '/v1/responses',
    observed_error: { chain: COMPLETE_ERROR_CHAIN },
  };
  if (includeExecutionMode) meta.execution_mode = executionMode;
  return {
    request_key: '12345:req-exhausted',
    event_type: 'request.failed',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 120,
    finished_epoch_ms: 120,
    attempts: 0,
    meta,
  };
}

function writeTypedSource(root, {
  requestId = 'req-exhausted',
  port = 12345,
  code = 'provider_concurrency_busy',
  sourceKind = 'target_pool_exhausted',
  sourceStage = 'V3Target10ConcreteProviderSelected',
  attempts = [],
} = {}) {
  const sampleRoot = join(root, 'home', '.rcc', 'codex-samples');
  const sampleDir = join(sampleRoot, 'openai-responses', 'ports', String(port), requestId);
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(join(sampleDir, 'provider-failed-attempts.json'), `${JSON.stringify({
    object: 'routecodex.v3.provider_failed_attempt_evidence',
    request_id: requestId,
    attempts,
    terminal_source: {
      source_kind: sourceKind,
      source_stage: sourceStage,
      code,
    },
  }, null, 2)}\n`);
  return sampleRoot;
}

test('concurrent replay holds one business send, closes the second request, then releases the holder', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-run-'));
  const harness = fakeHarness({ secondClient: CLOSED_BY_PRODUCT });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: fixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'passed', result.diagnostic);
    assert.equal(result.provider_attempt_count, 1);
    assert.equal(result.observations.provider_concurrency.upstream_business_sends, 1);
    assert.equal(harness.released, 1);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('mixed exclusion probes the excluded identity once, reuses released capacity, and preserves health', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-mixed-'));
  const harness = fakeMixedHarness();
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: mixedFixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'passed', result.diagnostic);
    assert.equal(result.provider_attempt_count, 2);
    assert.equal(result.observations.provider_concurrency.holder_business_sends, 1);
    assert.equal(result.observations.provider_concurrency.probe_sends, 1);
    assert.equal(result.observations.provider_concurrency.reuse_business_sends, 1);
    assert.equal(harness.released, 1);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('concurrent replay accepts SSE headers with comment-only keepalive before transport close', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-keepalive-'));
  const harness = fakeHarness({ secondClient: KEEPALIVE_THEN_CLOSED_BY_PRODUCT });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: fixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'passed', result.diagnostic);
    assert.equal(result.observations.provider_concurrency.exhausted_client.status, 200);
    assert.equal(result.observations.provider_concurrency.exhausted_client.closed, true);
    const timeline = result.observations.provider_concurrency.timeline;
    assert.ok(timeline.hold_observed_epoch_ms <= timeline.exhausted_send_started_epoch_ms);
    assert.ok(timeline.exhausted_send_settled_epoch_ms <= timeline.release_started_epoch_ms);
    assert.ok(timeline.release_started_epoch_ms <= timeline.holder_send_settled_epoch_ms);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('concurrent replay rejects a semantic SSE frame from the exhausted request', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-semantic-'));
  const harness = fakeHarness({
    secondClient: {
      ...KEEPALIVE_THEN_CLOSED_BY_PRODUCT,
      bodyText: 'event: error\ndata: {"error":{"code":"provider_concurrency_busy"}}\n\n',
    },
  });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: fixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.diagnostic, /business\/error SSE frame/);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('concurrent replay rejects timeout because it does not prove the product closed the transport', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-timeout-'));
  const harness = fakeHarness({
    secondClient: {
      ...CLOSED_BY_PRODUCT,
      error: 'request timed out after 500ms',
      error_detail: { code: 'ETIMEDOUT', message: 'request timed out after 500ms' },
      elapsed_ms: 500,
    },
  });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: fixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.diagnostic, /forbidden ETIMEDOUT/);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('concurrent replay rejects an extra upstream business send', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'provider-concurrency-extra-'));
  const harness = fakeHarness({ secondClient: CLOSED_BY_PRODUCT, extraCapture: true });
  try {
    const result = await runProviderConcurrencyReplay({
      fixture: fixture(),
      mock: harness.mock,
      rccUrl: 'http://127.0.0.1:12345',
      sendHttp: harness.sendHttp,
      evidenceRoot,
      timeoutMs: 1000,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.diagnostic, /business send count 2 != 1/);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('typed evidence collector binds the exhausted window to request.failed and provider_concurrency_busy', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-evidence-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root);
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.failed',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 120,
    finished_epoch_ms: 120,
    attempts: 1,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      entry_protocol: 'responses',
      execution_mode: null,
      observed_error: {
        chain: COMPLETE_ERROR_CHAIN,
      },
    },
  };
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
    JSON.stringify({ schema_version: 1, row }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'pass', result.findings.join('; '));
    assert.equal(result.matched_row.request_id, 'req-exhausted');
    assert.deepEqual(result.typed_error_codes, ['provider_concurrency_busy']);
    assert.equal(result.actual_mode, 'direct');
    assert.equal(result.actual_mode_source.request_id, 'req-holder');
    assert.equal(result.artifacts.records_written, true);
    assert.equal(result.artifacts.evidence_written, true);
    assert.equal(result.records_ref, join(root, 'provider-concurrency-records.jsonl'));
    assert.equal(result.evidence_ref, join(root, 'provider-concurrency-evidence.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed evidence accepts a generic exhausted source with no recorded attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-mixed-evidence-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root, {
    code: 'selected_target_exhausted',
    sourceKind: 'target_pool_exhausted',
    attempts: [],
  });
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
    JSON.stringify({
      schema_version: 1,
      row: {
        request_key: '12345:req-exhausted',
        event_type: 'request.failed',
        scope: { port: 12345 },
        started_epoch_ms: 110,
        updated_epoch_ms: 120,
        finished_epoch_ms: 120,
        attempts: 0,
        meta: {
          request_id: 'req-exhausted',
          endpoint: '/v1/responses',
          execution_mode: null,
          observed_error: { chain: COMPLETE_ERROR_CHAIN },
        },
      },
    }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: mixedFixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'pass', result.findings.join('; '));
    assert.equal(result.typed_source.terminal_source.source_kind, 'target_pool_exhausted');
    assert.deepEqual(result.typed_error_codes, ['selected_target_exhausted']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typed evidence collector classifies a flushed store with no terminal row as product mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-missing-terminal-'));
  const storePath = join(root, 'records.jsonl');
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.started',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 110,
    finished_epoch_ms: null,
    attempts: 0,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      execution_mode: null,
    },
  };
  writeFileSync(storePath, `${JSON.stringify({ schema_version: 1, row })}\n`);
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'mismatch');
    assert.match(result.findings.join('; '), /no typed concurrency source/);
    assert.equal(result.artifacts.evidence_written, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typed evidence collector binds provider_concurrency_busy from isolated codex sample evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-typed-sample-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root);
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.started',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 110,
    finished_epoch_ms: null,
    attempts: 0,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      execution_mode: null,
    },
  };
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
    JSON.stringify({ schema_version: 1, row }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'pass', result.findings.join('; '));
    assert.equal(result.typed_source.kind, 'provider_failed_attempts');
    assert.deepEqual(result.typed_source.codes, ['provider_concurrency_busy']);
    assert.equal(result.typed_source_ref, join(root, 'provider-concurrency-typed-source.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typed evidence collector retains a mismatched terminal source from the exhausted request', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-typed-mismatch-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root, { code: 'selected_target_exhausted' });
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.failed',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 110,
    finished_epoch_ms: 110,
    attempts: 0,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      execution_mode: null,
      observed_error: { code: 'selected_target_exhausted' },
    },
  };
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
    JSON.stringify({ schema_version: 1, row }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.typed_source.kind, 'provider_failed_attempts');
    assert.equal(result.typed_source.request_id, 'req-exhausted');
    assert.deepEqual(result.typed_source.observed_codes, ['selected_target_exhausted']);
    assert.equal(result.typed_source.terminal_source.code, 'selected_target_exhausted');
    assert.match(result.findings.join('; '), /typed error codes missing at terminal source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typed evidence collector rejects wrong terminal source kind or stage', () => {
  for (const override of [
    { sourceKind: 'candidate_unavailable' },
    { sourceStage: 'V3Error01SourceRaised' },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-terminal-shape-'));
    const storePath = join(root, 'records.jsonl');
    const sampleRoot = writeTypedSource(root, override);
    const row = {
      request_key: '12345:req-exhausted',
      event_type: 'request.failed',
      scope: { port: 12345 },
      started_epoch_ms: 110,
      updated_epoch_ms: 120,
      finished_epoch_ms: 120,
      attempts: 0,
      meta: {
        request_id: 'req-exhausted',
        endpoint: '/v1/responses',
        execution_mode: null,
        observed_error: { chain: COMPLETE_ERROR_CHAIN },
      },
    };
    writeFileSync(storePath, [
      JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
      JSON.stringify({ schema_version: 1, row }),
      '',
    ].join('\n'));
    try {
      const result = collectProviderConcurrencyEvidence({
        fixture: fixture(),
        caseRoot: root,
        storePath,
        sampleRoot,
        listenerPort: 12345,
        exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
        collectionPhase: 'post_stop_complete',
        stopReceipt: { complete: true },
      });
      assert.equal(result.status, 'mismatch');
      assert.match(result.findings.join('; '), /terminal source (?:kind|stage)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('typed evidence collector rejects an expected code found only in attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-recursive-code-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root, {
    code: 'selected_target_exhausted',
    attempts: [{ code: 'provider_concurrency_busy' }],
  });
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.failed',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 120,
    finished_epoch_ms: 120,
    attempts: 1,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      execution_mode: null,
      observed_error: {
        chain: COMPLETE_ERROR_CHAIN,
        attempts: [{ code: 'provider_concurrency_busy' }],
      },
    },
  };
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow() }),
    JSON.stringify({ schema_version: 1, row }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'mismatch');
    assert.deepEqual(result.typed_error_codes, []);
    assert.match(result.findings.join('; '), /typed error codes missing at terminal source/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relay evidence requires a matching request.failed row and complete Error01-06 chain', () => {
  for (const variant of ['missing-failed', 'incomplete-chain']) {
    const root = mkdtempSync(join(tmpdir(), `provider-concurrency-relay-${variant}-`));
    const storePath = join(root, 'records.jsonl');
    const sampleRoot = writeTypedSource(root);
    const rows = [routeSelectedRow({ mode: 'relay' })];
    if (variant === 'incomplete-chain') {
      rows.push({
        request_key: '12345:req-exhausted',
        event_type: 'request.failed',
        scope: { port: 12345 },
        started_epoch_ms: 110,
        updated_epoch_ms: 120,
        finished_epoch_ms: 120,
        attempts: 0,
        meta: {
          request_id: 'req-exhausted',
          endpoint: '/v1/responses',
          execution_mode: 'relay',
          observed_error: {
            chain: COMPLETE_ERROR_CHAIN.filter(({ node }) => node !== 'V3Error06ClientProjected'),
          },
        },
      });
    } else {
      rows.push({
        request_key: '12345:req-exhausted',
        event_type: 'request.started',
        scope: { port: 12345 },
        started_epoch_ms: 110,
        updated_epoch_ms: 110,
        finished_epoch_ms: null,
        attempts: 0,
        meta: {
          request_id: 'req-exhausted',
          endpoint: '/v1/responses',
          execution_mode: null,
        },
      });
    }
    writeFileSync(storePath, [
      ...rows.map((row) => JSON.stringify({ schema_version: 1, row })),
      '',
    ].join('\n'));
    try {
      const result = collectProviderConcurrencyEvidence({
        fixture: fixture({
          case_id: 'issue-745f6e9-provider-concurrency-all-busy-relay',
          cell: {
            entry_protocol: 'responses',
            provider_protocol: 'openai_chat',
            transport: 'sse',
            mode: 'relay',
          },
        }),
        caseRoot: root,
        storePath,
        sampleRoot,
        listenerPort: 12345,
        exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
        collectionPhase: 'post_stop_complete',
        stopReceipt: { complete: true },
      });
      assert.equal(result.status, 'mismatch');
      assert.match(
        result.findings.join('; '),
        variant === 'missing-failed'
          ? /missing its matching request\.failed row/u
          : /missing the V3Error01-06 chain/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('relay evidence accepts a matching failure-row mode and preserves the raw mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-relay-mode-positive-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root);
  writeFileSync(storePath, [
    JSON.stringify({ schema_version: 1, row: routeSelectedRow({ mode: 'relay' }) }),
    JSON.stringify({ schema_version: 1, row: relayFailureRow() }),
    '',
  ].join('\n'));
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture({
        case_id: 'issue-745f6e9-provider-concurrency-all-busy-relay',
        cell: {
          entry_protocol: 'responses',
          provider_protocol: 'openai_chat',
          transport: 'sse',
          mode: 'relay',
        },
      }),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'pass', result.findings.join('; '));
    assert.equal(result.actual_mode, 'relay');
    assert.equal(result.matched_row.execution_mode, 'relay');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relay evidence rejects null, missing, or wrong failure-row modes', () => {
  for (const variant of [
    { label: 'null', executionMode: null, observed: 'null' },
    { label: 'missing', includeExecutionMode: false, observed: 'missing' },
    { label: 'wrong', executionMode: 'direct', observed: 'direct' },
  ]) {
    const root = mkdtempSync(join(tmpdir(), `provider-concurrency-relay-mode-${variant.label}-`));
    const storePath = join(root, 'records.jsonl');
    const sampleRoot = writeTypedSource(root);
    writeFileSync(storePath, [
      JSON.stringify({ schema_version: 1, row: routeSelectedRow({ mode: 'relay' }) }),
      JSON.stringify({
        schema_version: 1,
        row: relayFailureRow({
          executionMode: variant.executionMode,
          includeExecutionMode: variant.includeExecutionMode,
        }),
      }),
      '',
    ].join('\n'));
    try {
      const result = collectProviderConcurrencyEvidence({
        fixture: fixture({
          case_id: 'issue-745f6e9-provider-concurrency-all-busy-relay',
          cell: {
            entry_protocol: 'responses',
            provider_protocol: 'openai_chat',
            transport: 'sse',
            mode: 'relay',
          },
        }),
        caseRoot: root,
        storePath,
        sampleRoot,
        listenerPort: 12345,
        exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
        collectionPhase: 'post_stop_complete',
        stopReceipt: { complete: true },
      });
      assert.equal(result.status, 'mismatch');
      assert.match(
        result.findings.join('; '),
        new RegExp(`failure row execution mode expected relay, observed ${variant.observed}`, 'u'),
      );
      assert.equal(
        result.matched_row.execution_mode,
        variant.includeExecutionMode === false ? null : variant.executionMode,
      );
      assert.equal(result.actual_mode, 'relay');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('typed evidence collector does not infer execution mode without a route-selected record', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-concurrency-mode-missing-'));
  const storePath = join(root, 'records.jsonl');
  const sampleRoot = writeTypedSource(root);
  const row = {
    request_key: '12345:req-exhausted',
    event_type: 'request.failed',
    scope: { port: 12345 },
    started_epoch_ms: 110,
    updated_epoch_ms: 120,
    finished_epoch_ms: 120,
    attempts: 0,
    meta: {
      request_id: 'req-exhausted',
      endpoint: '/v1/responses',
      execution_mode: null,
      observed_error: { chain: COMPLETE_ERROR_CHAIN },
    },
  };
  writeFileSync(storePath, `${JSON.stringify({ schema_version: 1, row })}\n`);
  try {
    const result = collectProviderConcurrencyEvidence({
      fixture: fixture(),
      caseRoot: root,
      storePath,
      sampleRoot,
      listenerPort: 12345,
      exhaustedWindow: { started_epoch_ms: 100, settled_epoch_ms: 130 },
      collectionPhase: 'post_stop_complete',
      stopReceipt: { complete: true },
    });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.actual_mode, null);
    assert.match(result.findings.join('; '), /execution mode mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
