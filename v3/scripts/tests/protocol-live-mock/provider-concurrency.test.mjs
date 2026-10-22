import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectProviderConcurrencyEvidence,
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
