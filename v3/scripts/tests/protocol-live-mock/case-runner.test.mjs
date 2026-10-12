import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCase } from './case-runner.mjs';

const toolFixture = JSON.parse(readFileSync(
  new URL('../../../fixtures/protocol-live-mock-matrix/cases/tool-followup-responses-to-chat.json', import.meta.url),
  'utf8',
));
const TEST_PROVIDER_AUTH = 'Bearer test-fake-token';
const ACTUAL_CALL_ID = 'call_actual_runner';
const ACTUAL_TOOL_TEXT = 'live-ping';
const ACTUAL_FINAL_TEXT = 'done-actual';

// Independent, protocol-native wire shapes for the declared
// responses -> responses pass-through. The fake provider serves these exact
// bytes; the case runner's own fixture is the only thing under assertion, so
// these constants are never derived from expected_provider/expected_client.
const ACTUAL_TOOL_DECLARATION = {
  type: 'function',
  name: 'echo',
  description: 'Return the provided text unchanged.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

const ACTUAL_PROVIDER_REQUEST = [
  {
    model: 'chat-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'call echo then report' }],
    }],
    tools: [ACTUAL_TOOL_DECLARATION],
    stream: true,
  },
  {
    model: 'chat-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'call echo then report' }],
      },
      {
        type: 'function_call',
        call_id: ACTUAL_CALL_ID,
        name: 'echo',
        arguments: JSON.stringify({ text: ACTUAL_TOOL_TEXT }),
      },
      { type: 'function_call_output', call_id: ACTUAL_CALL_ID, output: ACTUAL_TOOL_TEXT },
    ],
    tools: [ACTUAL_TOOL_DECLARATION],
    stream: false,
  },
];

const ACTUAL_PROVIDER_SSE_UPSTREAM = {
  protocol: 'responses',
  mode: 'sse',
  status: 200,
  content_type: 'text/event-stream',
  sse_events: [
    {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item: {
          id: 'msg_actual_call',
          type: 'function_call',
          call_id: ACTUAL_CALL_ID,
          name: 'echo',
          arguments: JSON.stringify({ text: ACTUAL_TOOL_TEXT }),
        },
      },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: 'resp_actual_1', status: 'completed' },
      },
    },
  ],
};

const ACTUAL_FOLLOWUP_PROVIDER_UPSTREAM = {
  protocol: 'responses',
  mode: 'json',
  status: 200,
  content_type: 'application/json',
  body: {
    id: 'resp_actual_2',
    object: 'response',
    model: 'chat-model',
    status: 'completed',
    output: [{
      id: 'msg_actual_final',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: ACTUAL_FINAL_TEXT }],
    }],
  },
};

const ACTUAL_TOOL_WIRE_ADAPTER = {
  provider_path: ['/v1/responses', '/v1/responses'],
  provider_request_exact: ACTUAL_PROVIDER_REQUEST,
  provider_upstream: [ACTUAL_PROVIDER_SSE_UPSTREAM, ACTUAL_FOLLOWUP_PROVIDER_UPSTREAM],
};

const simpleFixture = {
  schema_version: 1,
  case_id: 'module-chat-direct-json',
  cell: {
    entry_protocol: 'openai_chat',
    provider_protocol: 'openai_chat',
    transport: 'json',
    mode: 'direct',
  },
  client_request: {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: TEST_PROVIDER_AUTH,
    },
    body: {
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    },
  },
  expected_provider: {
    paths: ['/v1/chat/completions'],
    method: 'POST',
    auth_required: true,
    body_must: {
      model: 'chat-model',
      'messages.0.content': 'hello',
      stream: false,
    },
    body_must_not: ['routecodex_internal', 'metadata_center', 'debug_snapshot'],
    exact: null,
  },
  upstream_response: {
    protocol: 'openai_chat',
    mode: 'json',
    status: 200,
    content_type: 'application/json',
    body: {
      id: 'chatcmpl_module',
      object: 'chat.completion',
      model: 'chat-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    },
  },
  expected_client: {
    transport: 'complete',
    status: 200,
    body_must: {
      'choices.0.message.content': 'ok',
      'choices.0.finish_reason': 'stop',
      'usage.prompt_tokens': 7,
    },
    body_must_not: ['provider_error', 'internal_error', 'routecodex_internal'],
    semantic_terminal_required: true,
  },
  assertions: {
    provider_attempt_count: 1,
    probe_attempts_may_occur: true,
    no_control_leakage: true,
  },
};

function bodyTextFromFixture(upstream) {
  if (upstream.mode === 'sse') {
    return upstream.sse_events.map((event) => {
      const eventName = event.event ?? 'message';
      const data = event.data === undefined ? '' : JSON.stringify(event.data);
      return `event: ${eventName}\ndata: ${data}\n\n`;
    }).join('');
  }
  return JSON.stringify(upstream.body);
}

function mockResult(upstream, status = 200) {
  const bodyText = bodyTextFromFixture(upstream);
  return {
    status,
    status_text: '',
    headers: { 'content-type': upstream.content_type ?? 'application/json' },
    raw_headers: [['content-type', upstream.content_type ?? 'application/json']],
    body: upstream.mode === 'json' ? upstream.body : null,
    bodyText,
    bodyBytes: Buffer.from(bodyText, 'utf8'),
    bodyBytesBase64: Buffer.from(bodyText, 'utf8').toString('base64'),
    response_ended: true,
    complete: true,
    closed: false,
    aborted: false,
    truncated: false,
    elapsed_ms: 1,
    error: null,
    error_detail: null,
  };
}

/**
 * In-process loopback stand-in for the peer mock provider. It only implements
 * the consumed handle API and scripted turn windows; it is not an RCC baseline.
 */
function createMock(fixture, options = {}) {
  const calls = [];
  let active = { fixture: null, turnIndex: 0 };
  const captures = [];
  let sequence = 0;
  let businessIndex = 0;

  const turns = Array.isArray(fixture.turns) && fixture.turns.length > 0 ? fixture.turns : [];
  const upstreamFor = (turnIndex) => {
    if (turnIndex === 0) return turns[0]?.upstream_response ?? fixture.upstream_response;
    return turns[turnIndex]?.upstream_response ?? null;
  };

  return {
    port: 0,
    url: 'http://127.0.0.1:0/mocked',
    calls,
    captures,
    setActiveCase(value, turnIndex = 0) {
      active = { fixture: value, turnIndex };
    },
    setTurn(turnIndex) {
      active.turnIndex = turnIndex;
    },
    getCaptures(caseId) {
      assert.equal(caseId, active.fixture?.case_id ?? fixture.case_id);
      return [...captures];
    },
    async sendHttp(url, { method, headers, body, timeoutMs } = {}) {
      calls.push({
        url,
        method,
        headers,
        body,
        timeoutMs,
        turn_index: active.turnIndex,
      });
      const upstream = upstreamFor(active.turnIndex);
      assert.ok(upstream, `turn ${active.turnIndex + 1} has no upstream script`);
      const providerRequestBody = JSON.parse(String(body ?? '{}'));
      const captureHeaders = { ...(headers || {}) };
      const expectedProviderBody = options.wireAdapter?.provider_request_exact?.[active.turnIndex];
      if (expectedProviderBody !== undefined) {
        assert.deepEqual(providerRequestBody, expectedProviderBody, `turn ${active.turnIndex + 1} provider request body mismatch`);
      }
      const attemptIdentities = options.providerAttemptIdentities?.length
        ? options.providerAttemptIdentities
        : [captureHeaders.authorization];
      for (const authorization of attemptIdentities) {
        captures.push({
          attempt_kind: 'business',
          case_index: sequence++,
          method,
          path: options.wireAdapter?.provider_path?.[active.turnIndex] ?? new URL(url).pathname,
          query: '',
          headers: Object.fromEntries(Object.entries({ ...captureHeaders, authorization }).map(([key, value]) => [String(key).toLowerCase(), String(value)])),
          raw_body: String(body ?? ''),
          body: providerRequestBody,
          captured_at_epoch_ms: Date.now(),
          business_index: businessIndex++,
        });
      }
      if (options.failClient) throw new Error('endpoint unavailable for negative control');
      return options.transformResult ? options.transformResult(mockResult(upstream)) : mockResult(upstream);
    },
  };
}

function tempEvidenceRoot() {
  const root = mkdtempSync(join(tmpdir(), 'case-runner-evidence-'));
  return root;
}

function actualToolFixture() {
  const fixture = structuredClone(toolFixture);
  fixture.case_id = 'module-tool-followup-actual';
  // The in-process fake is a same-protocol pass-through, so declare the
  // fixture's entry and provider protocols as responses -> responses.
  fixture.cell.provider_protocol = 'responses';
  fixture.client_request.headers = { ...fixture.client_request.headers, authorization: TEST_PROVIDER_AUTH };
  fixture.client_request.body.model = 'chat-model';
  fixture.turns[0].client_request.headers = { ...fixture.turns[0].client_request.headers, authorization: TEST_PROVIDER_AUTH };
  fixture.turns[0].client_request.body.model = 'chat-model';
  fixture.turns[1].client_request.headers = { ...fixture.turns[1].client_request.headers, authorization: TEST_PROVIDER_AUTH };
  fixture.turns[1].client_request.body.model = 'chat-model';
  fixture.turns[1].client_request.body.tools = [structuredClone(ACTUAL_TOOL_DECLARATION)];
  fixture.turns[1].client_request.body.stream = false;
  fixture.upstream_response = structuredClone(ACTUAL_PROVIDER_SSE_UPSTREAM);
  fixture.expected_provider = {
    paths: ['/v1/responses'],
    method: 'POST',
    auth_required: true,
    body_must: {
      model: 'chat-model',
      'input.0.role': 'user',
      'tools.0.name': 'echo',
    },
    body_must_not: ['routecodex_internal', 'metadata_center', 'debug_snapshot'],
    exact: null,
  };
  fixture.turns[0].expected_client_must = {
    'item.type': 'function_call',
    'item.name': 'echo',
    'item.call_id': ACTUAL_CALL_ID,
    'item.arguments': JSON.stringify({ text: ACTUAL_TOOL_TEXT }),
  };
  fixture.turns[1].expected_provider_exact = structuredClone(ACTUAL_PROVIDER_REQUEST[1]);
  fixture.turns[1].upstream_response = structuredClone(ACTUAL_FOLLOWUP_PROVIDER_UPSTREAM);
  fixture.turns[1].expected_client_must = {
    'output.0.content.0.text': ACTUAL_FINAL_TEXT,
    status: 'completed',
  };
  return fixture;
}

function runActualToolFixture(fixture, root) {
  const mock = createMock(fixture, { wireAdapter: ACTUAL_TOOL_WIRE_ADAPTER });
  return runCase({
    fixture,
    mock,
    rccUrl: 'http://127.0.0.1:0/',
    sendHttp: mock.sendHttp,
    evidenceRoot: root,
  }).then((report) => ({ report, mock }));
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

test('runCase executes the declared echo once from the actual response and sends actual call id/output', async () => {
  const root = tempEvidenceRoot();
  try {
    const actualFixture = actualToolFixture();
    const { report, mock } = await runActualToolFixture(actualFixture, root);

    assert.equal(report.status, 'passed');
    assert.equal(report.turn_results.length, 2);
    assert.equal(report.turn_results[1].request_source, 'tool-consumer');
    assert.deepEqual(mock.calls.map((call) => call.turn_index), [0, 1]);
    assert.deepEqual(
      mock.calls.map((call) => new URL(call.url).pathname),
      ['/v1/responses', '/v1/responses'],
    );
    assert.deepEqual(mock.captures.map((capture) => capture.path), [
      '/v1/responses',
      '/v1/responses',
    ]);
    assert.equal(mock.captures[0].body.model, 'chat-model');
    assert.equal(mock.captures[1].body.model, 'chat-model');
    assert.equal(mock.captures[1].body.input.length, 3);

    const sentFollowup = JSON.parse(mock.calls[1].body);
    assert.deepEqual(sentFollowup.input.slice(-2), [
      {
        type: 'function_call',
        call_id: ACTUAL_CALL_ID,
        name: 'echo',
        arguments: JSON.stringify({ text: ACTUAL_TOOL_TEXT }),
      },
      { type: 'function_call_output', call_id: ACTUAL_CALL_ID, output: ACTUAL_TOOL_TEXT },
    ]);
    assert.equal(sentFollowup.stream, false);
    const toolExecution = report.observations.live.find((entry) => entry.kind === 'tool_execution');
    assert.ok(toolExecution, 'tool execution observation must be present');
    assert.equal(toolExecution.executions.length, 1);
    assert.equal(toolExecution.executions[0].output, ACTUAL_TOOL_TEXT);

    const firstProviderEvidence = JSON.parse(readFileSync(join(root, 'captures', 'module-tool-followup-actual-turn-1-provider.json'), 'utf8'));
    assert.equal(firstProviderEvidence.business_attempts, 1);
    assert.equal(firstProviderEvidence.scripted_attempts, 1);
    const secondProviderEvidence = JSON.parse(readFileSync(join(root, 'captures', 'module-tool-followup-actual-turn-2-provider.json'), 'utf8'));
    assert.equal(secondProviderEvidence.turn, 2);
    assert.equal(secondProviderEvidence.provider_captures[0].body.input[1].call_id, ACTUAL_CALL_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCase keeps the case-wide terminal and forbidden contract for a turn with expected_client_must', async () => {
  const root = tempEvidenceRoot();
  try {
    const actualFixture = actualToolFixture();
    const { report, mock } = await runActualToolFixture(actualFixture, root);

    assert.equal(report.status, 'passed', report.diagnostic);
    assert.equal(report.turn_results[0].status, 'passed');
    assert.equal(report.turn_results[1].status, 'passed');
    // The first turn is a function call, so the tool consumer must still run.
    assert.equal(report.turn_results[1].request_source, 'tool-consumer');
    assert.equal(mock.calls.length, 2);

    const missingTerminalFixture = actualToolFixture();
    missingTerminalFixture.case_id = 'module-tool-followup-missing-terminal';
    missingTerminalFixture.upstream_response = {
      ...structuredClone(ACTUAL_PROVIDER_SSE_UPSTREAM),
      sse_events: ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.filter((event) => event.event !== 'response.completed'),
    };
    const missingTerminal = await runActualToolFixture(missingTerminalFixture, root);
    assert.equal(missingTerminal.report.status, 'failed');
    assert.match(missingTerminal.report.diagnostic, /semantic terminal missing/u);
    // The dropped terminal must not silently authorize tool execution.
    assert.equal(missingTerminal.mock.calls.length, 1);
    assert.equal(missingTerminal.report.turn_results.length, 1);
    assert.equal(
      missingTerminal.report.observations.live.some((entry) => entry.kind === 'tool_execution'),
      false,
    );

    const forbiddenContentFixture = actualToolFixture();
    forbiddenContentFixture.case_id = 'module-tool-followup-forbidden-content';
    forbiddenContentFixture.upstream_response = {
      ...structuredClone(ACTUAL_PROVIDER_SSE_UPSTREAM),
      sse_events: [
        ...ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.slice(0, -1),
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'provider_error: upstream leaked' },
        },
        ...ACTUAL_PROVIDER_SSE_UPSTREAM.sse_events.slice(-1),
      ],
    };
    const forbiddenContent = await runActualToolFixture(forbiddenContentFixture, root);
    assert.equal(forbiddenContent.report.status, 'failed');
    assert.match(forbiddenContent.report.diagnostic, /forbidden provider_error/u);
    assert.equal(forbiddenContent.mock.calls.length, 1);
    assert.equal(
      forbiddenContent.report.observations.live.some((entry) => entry.kind === 'tool_execution'),
      false,
    );

    const invalidTransportFixture = actualToolFixture();
    invalidTransportFixture.case_id = 'module-tool-followup-invalid-transport';
    invalidTransportFixture.turns[0].expected_client_contract = {
      transport: 'bogus',
    };
    const invalidTransport = await runActualToolFixture(invalidTransportFixture, root);
    assert.equal(invalidTransport.report.status, 'failed');
    assert.match(invalidTransport.report.diagnostic, /unknown expected client transport bogus/u);
    assert.equal(invalidTransport.mock.calls.length, 1);
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
