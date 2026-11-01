import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCase } from './case-runner.mjs';

const toolFixture = JSON.parse(readFileSync(
  new URL('../../../fixtures/protocol-live-mock-matrix/cases/tool-followup-responses-to-chat.json', import.meta.url),
  'utf8',
));
export const TEST_PROVIDER_AUTH = 'Bearer test-fake-token';
export const ACTUAL_CALL_ID = 'call_actual_runner';
export const ACTUAL_TOOL_TEXT = 'live-ping';
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

export const ACTUAL_PROVIDER_SSE_UPSTREAM = {
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

export const simpleFixture = {
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
export function createMock(fixture, options = {}) {
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

export function tempEvidenceRoot() {
  const root = mkdtempSync(join(tmpdir(), 'case-runner-evidence-'));
  return root;
}

export function actualToolFixture() {
  const fixture = structuredClone(toolFixture);
  fixture.case_id = 'module-tool-followup-actual';
  // The in-process fake is a same-protocol pass-through, so declare the
  // fixture's entry and provider protocols as responses -> responses.
  fixture.cell.provider_protocol = 'responses';
  fixture.client_request.headers = { ...fixture.client_request.headers, authorization: TEST_PROVIDER_AUTH };
  fixture.client_request.body.model = 'chat-model';
  // The module script observes live-ping, so the declared expectation matches it.
  fixture.tool_followup.expected_output = ACTUAL_TOOL_TEXT;
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

export function runActualToolFixture(fixture, root) {
  const mock = createMock(fixture, { wireAdapter: ACTUAL_TOOL_WIRE_ADAPTER });
  return runCase({
    fixture,
    mock,
    rccUrl: 'http://127.0.0.1:0/',
    sendHttp: mock.sendHttp,
    evidenceRoot: root,
  }).then((report) => ({ report, mock }));
}
