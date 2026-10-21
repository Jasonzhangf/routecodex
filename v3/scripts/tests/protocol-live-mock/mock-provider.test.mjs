// Focused tests for the protocol live-mock loopback mock provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MockProviderError, startMockProvider } from './mock-provider.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..', '..', '..', '..', 'v3', 'fixtures', 'protocol-live-mock-matrix', 'cases');

function readCase(caseId) {
  return JSON.parse(readFileSync(join(caseRoot, `${caseId}.json`), 'utf8'));
}

function fixture(overrides = {}) {
  return {
    case_id: 'mock-case',
    cell: { entry_protocol: 'openai_chat', provider_protocol: 'openai_chat', transport: 'json', mode: 'direct' },
    upstream_response: {
      protocol: 'openai_chat',
      mode: 'json',
      status: 200,
      content_type: 'application/json',
      body: { ok: true },
    },
    ...overrides,
  };
}

function request(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs } = options;
  return new Promise((resolve) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      let ended = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
        const bytes = Buffer.concat(chunks);
        const bodyText = bytes.toString('utf8');
        let json = null;
        try { json = bodyText ? JSON.parse(bodyText) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, bytes, bodyText, json, ended: true, closed: false, error: null });
      });
      res.on('aborted', () => resolve({ status: res.statusCode ?? null, headers: res.headers, bytes: Buffer.concat(chunks), bodyText: Buffer.concat(chunks).toString('utf8'), json: null, ended: false, closed: true, error: 'aborted' }));
      res.on('close', () => {
        if (!ended) resolve({ status: res.statusCode ?? null, headers: res.headers, bytes: Buffer.concat(chunks), bodyText: Buffer.concat(chunks).toString('utf8'), json: null, ended: false, closed: true, error: null });
      });
    });
    req.on('error', (error) => resolve({ status: null, headers: {}, bytes: Buffer.alloc(0), bodyText: '', json: null, ended: false, closed: true, error: error.code ?? error.message }));
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function postJson(url, body, extraHeaders = {}) {
  return request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body });
}

test('request shape guard rejects before the scripted business response', async () => {
  const mock = await startMockProvider({
    validateRequest(capture) {
      if (capture.body?.retain !== true) {
        throw new MockProviderError('mock_missing_retained_field', 'retain must reach the provider');
      }
    },
  });
  try {
    mock.setActiveCase(fixture());
    const rejected = await postJson(`${mock.url}/v1/chat/completions`, {});
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, 'mock_missing_retained_field');
    const accepted = await postJson(`${mock.url}/v1/chat/completions`, { retain: true });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.json, { ok: true });
    assert.equal(mock.getCaptures()[0].response_script.status, 400);
    assert.equal(mock.getCaptures()[1].response_script.status, 200);
  } finally {
    await mock.close();
  }
});

// Path smoke observation only. The client closes its own connection after it
// sees the required bytes; this does not report a completed business response.
function observeScriptPrefix(url, body, expectedPrefix, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const expected = Buffer.from(expectedPrefix);
    const chunks = [];
    let response;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(result);
      response?.destroy();
      req.destroy();
    };
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      response = res;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const compared = Math.min(bytes.length, expected.length);
        if (!bytes.subarray(0, compared).equals(expected.subarray(0, compared))) {
          finish(new Error('mock prefix differs from the scripted prefix'));
        } else if (bytes.length >= expected.length) {
          finish(null, { status: res.statusCode, headers: res.headers, bytes, prefixObserved: true, ended: false });
        }
      });
      for (const event of ['end', 'aborted', 'close']) {
        res.on(event, () => finish(new Error(`mock response ${event} before the required prefix`)));
      }
      res.on('error', (error) => finish(error));
    });
    const deadline = setTimeout(() => finish(new Error('mock prefix observation deadline expired')), timeoutMs);
    req.on('error', (error) => finish(error));
    req.end(JSON.stringify(body));
  });
}

function firstRawFrame(script) {
  const event = script.sse_events?.[0];
  const raw = event?.raw ?? (event
    ? `${event.event ? `event: ${event.event}\n` : ''}data: ${
      typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
    }\n\n`
    : undefined);
  assert.equal(typeof raw, 'string', 'hold-open path smoke requires its actual raw prefix');
  const boundary = raw.indexOf('\n\n');
  assert.ok(boundary >= 0, 'hold-open script must contain a complete initial SSE frame');
  return raw.slice(0, boundary + 2);
}

test('openai_chat JSON captures the exact raw request and returns the scripted body', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  server.setActiveCase(fixture());
  const result = await postJson(`${server.url}/v1/chat/completions?trace=1`, { model: 'mock.chat-model', messages: [{ role: 'user', content: 'hello' }] }, { authorization: 'Bearer fake-token' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true });

  const captures = server.getCaptures('mock-case');
  assert.equal(captures.length, 1);
  const [capture] = captures;
  assert.equal(capture.attempt_kind, 'business');
  assert.equal(capture.protocol, 'openai_chat');
  assert.equal(capture.method, 'POST');
  assert.equal(capture.path, '/v1/chat/completions');
  assert.equal(capture.query, '?trace=1');
  assert.equal(capture.headers.authorization, 'Bearer fake-token');
  assert.equal(capture.headers['content-type'], 'application/json');
  assert.equal(capture.body_parsed, true);
  assert.deepEqual(capture.body, { model: 'mock.chat-model', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(capture.raw_body, '{"model":"mock.chat-model","messages":[{"role":"user","content":"hello"}]}');
  assert.equal(capture.case_id, 'mock-case');
  assert.equal(capture.turn, 0);
  assert.equal(capture.attempt, 0);
  assert.equal(capture.phase, 'case');
  assert.deepEqual(capture.response_script, { protocol: 'openai_chat', mode: 'json', status: 200, content_type: 'application/json', body: { ok: true } });
  assert.equal(capture.response_wire.mode, 'json');
  assert.equal(capture.response_wire.status, 200);
  assert.equal(capture.response_wire.content_type, 'application/json');
  assert.equal(capture.response_wire.text, '{"ok":true}');
  assert.equal(capture.response_wire.text_byte_length, Buffer.byteLength('{"ok":true}'));
  assert.equal(capture.response_wire.bytes_base64, Buffer.from('{"ok":true}').toString('base64'));
  assert.equal(capture.response_wire.complete, true);
});

test('all four endpoint families are accepted, including Gemini generate and stream plus query', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  const cells = [
    { provider: 'responses', path: '/v1/responses' },
    { provider: 'anthropic', path: '/v1/messages' },
    { provider: 'gemini', path: '/v1beta/models/gemini-model:generateContent' },
    { provider: 'gemini', path: '/v1beta/models/gemini-model:streamGenerateContent?alt=sse' },
  ];
  for (const [index, cell] of cells.entries()) {
    const caseId = `endpoint-${index}`;
    server.setActiveCase({
      case_id: caseId,
      cell: { entry_protocol: cell.provider, provider_protocol: cell.provider, transport: 'json', mode: 'direct' },
      upstream_response: { protocol: cell.provider, mode: 'json', status: 200, content_type: 'application/json', body: { endpoint: cell.path } },
    });
    const result = await postJson(`${server.url}${cell.path}`, { probe: true });
    assert.equal(result.status, 200, `${cell.path} status`);
    assert.deepEqual(result.json, { endpoint: cell.path });
    const [capture] = server.getCaptures(caseId);
    assert.equal(capture.protocol, cell.provider);
    assert.equal(capture.path, cell.path.split('?')[0]);
    assert.equal(capture.query, cell.path.includes('?') ? `?${cell.path.split('?')[1]}` : '');
  }
});

test('SSE preserves exact raw chunks, frame order, and the raw [DONE] data literal', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());

  server.setActiveCase({
    case_id: 'raw-chunks',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: { protocol: 'openai_chat', mode: 'sse', status: 200, content_type: 'text/event-stream', chunks: ['data: first\n\n', 'data: second\n\n'] },
  });
  const ordered = await postJson(`${server.url}/v1/chat/completions`, { stream: true });
  assert.equal(ordered.bodyText, 'data: first\n\ndata: second\n\n');
  const [orderedCapture] = server.getCaptures('raw-chunks');
  assert.equal(orderedCapture.response_wire.text, ordered.bodyText);
  assert.equal(orderedCapture.response_wire.bytes_base64, ordered.bytes.toString('base64'));
  assert.equal(orderedCapture.response_wire.complete, true);

  server.setActiveCase({
    case_id: 'done-literal',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: {
      protocol: 'openai_chat',
      mode: 'sse',
      status: 200,
      content_type: 'text/event-stream',
      sse_events: [
        { data: { id: 'chunk-1', choices: [{ delta: { content: 'hi' } }] } },
        { data: '[DONE]' },
      ],
    },
  });
  const done = await postJson(`${server.url}/v1/chat/completions`, { stream: true });
  assert.equal(done.bodyText, 'data: {"id":"chunk-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  // Red control: [DONE] must stay a raw data literal, not JSON.stringify-quoted.
  assert.ok(!done.bodyText.includes('"[DONE]"'), 'DONE must not be JSON stringified');
  assert.ok(!done.bodyText.includes(`data: ${JSON.stringify('[DONE]')}\n\n`), 'red control: JSON-quoted DONE would be the failure mode');
  assert.ok(done.bodyText.endsWith('data: [DONE]\n\n'));

  server.setActiveCase({
    case_id: 'named-event',
    cell: { provider_protocol: 'anthropic' },
    upstream_response: { protocol: 'anthropic', mode: 'sse', status: 200, content_type: 'text/event-stream', sse_events: [{ event: 'message_start', data: { type: 'message_start' } }] },
  });
  const named = await postJson(`${server.url}/v1/messages`, { stream: true });
  assert.equal(named.bodyText, 'event: message_start\ndata: {"type":"message_start"}\n\n');
});

test('fault attempts advance deterministically and the recovered attempt is delivered', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  server.setActiveCase({
    case_id: 'fault-retry',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: {
      protocol: 'openai_chat',
      mode: 'fault',
      status: 200,
      content_type: 'text/event-stream',
      fault: 'stream_cut_before_content',
      close_after_bytes: 64,
      attempts: [
        { kind: 'fault', fault: 'stream_cut_before_content', close_after_bytes: 64, sse_events: [{ data: { id: 'cut', choices: [{ index: 0, delta: { role: 'assistant' } }] } }] },
        { kind: 'json', status: 200, content_type: 'application/json', body: { id: 'recovered', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
      ],
    },
  });
  const cut = await postJson(`${server.url}/v1/chat/completions`, { stream: true });
  assert.equal(cut.status, 200);
  assert.equal(cut.bytes.length, 64, 'truncated attempt must stop at close_after_bytes');
  assert.ok(!cut.bodyText.includes('[DONE]'));
  const completeFirstAttempt = `data: ${JSON.stringify({ id: 'cut', choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`;
  assert.ok(cut.bytes.length < Buffer.byteLength(completeFirstAttempt), 'red control: truncate must not deliver the complete first attempt');
  const recovered = await postJson(`${server.url}/v1/chat/completions`, { stream: true });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.json, { id: 'recovered', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });

  const captures = server.getCaptures('fault-retry');
  assert.equal(captures.length, 2);
  assert.deepEqual(captures.map((capture) => capture.attempt), [0, 1]);
  assert.deepEqual(captures.map((capture) => capture.response_script.mode), ['fault', 'json']);
  assert.equal(captures[1].attempt_repeated, false);
});

test('reset destroys the transport and hold-open stays open until close()', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  server.setActiveCase({
    case_id: 'reset-case',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: { protocol: 'openai_chat', mode: 'fault', status: 200, fault: 'reset' },
  });
  const reset = await postJson(`${server.url}/v1/chat/completions`, { stream: true });
  assert.equal(reset.status, null);
  assert.ok(reset.error, 'reset must surface a transport error, not a completed response');

  server.setActiveCase({
    case_id: 'hold-open-case',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: { protocol: 'openai_chat', mode: 'fault', status: 200, fault: 'hold-open' },
  });
  let sawResponse = false;
  let ended = false;
  const pending = new Promise((resolve) => {
    const req = http.request(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      sawResponse = true;
      res.resume();
      res.on('end', () => { ended = true; resolve('end'); });
      res.on('aborted', () => resolve('aborted'));
      res.on('close', () => resolve(ended ? 'end' : 'closed'));
    });
    req.on('error', () => resolve('error'));
    req.end(JSON.stringify({ stream: true }));
  });
  await waitFor(() => sawResponse);
  assert.equal(sawResponse, true);
  await sleep(120);
  assert.equal(ended, false, 'hold-open must not end on its own');
  await server.close();
  assert.notEqual(await pending, 'end');
});

test('controlled hold releases the same captured response exactly once', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  server.setActiveCase({
    case_id: 'controlled-hold-case',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: {
      protocol: 'openai_chat',
      mode: 'fault',
      status: 200,
      content_type: 'text/event-stream',
      fault: 'hold-open-controlled',
      attempts: [{
        kind: 'fault',
        fault: 'hold-open-controlled',
        sse_events: [
          { data: { id: 'held', choices: [{ delta: { content: 'held' } }] } },
          { data: '[DONE]' },
        ],
      }],
    },
  });
  const pending = postJson(`${server.url}/v1/chat/completions`, { stream: true });
  await server.waitForHeld('controlled-hold-case', 1000);
  assert.equal(server.getCaptures('controlled-hold-case').length, 1);
  assert.equal(server.getCaptures('controlled-hold-case')[0].attempt_kind, 'business');
  assert.equal(await server.releaseHeld('controlled-hold-case'), 1);
  const released = await pending;
  assert.equal(released.status, 200);
  assert.match(released.bodyText, /"content":"held"/);
  assert.ok(released.bodyText.endsWith('data: [DONE]\n\n'));
  assert.equal(released.ended, true);
  assert.equal(await server.releaseHeld('controlled-hold-case'), 0);
  assert.equal(server.getCaptures('controlled-hold-case').length, 1);
});

test('multi-turn fixtures switch scripts by turn and reset the per-turn attempt index', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  server.setActiveCase({
    case_id: 'multi-turn',
    cell: { provider_protocol: 'openai_chat' },
    upstream_response: { protocol: 'openai_chat', mode: 'json', status: 200, content_type: 'application/json', body: { turn: 'first' } },
    turns: [
      {},
      { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/chat/completions', body: {} }, upstream_response: { protocol: 'openai_chat', mode: 'json', status: 200, content_type: 'application/json', body: { turn: 'second' } } },
    ],
  });
  const first = await postJson(`${server.url}/v1/chat/completions`, { turn: 1 });
  assert.deepEqual(first.json, { turn: 'first' });
  server.setTurn(1);
  const second = await postJson(`${server.url}/v1/chat/completions`, { turn: 2 });
  assert.deepEqual(second.json, { turn: 'second' });
  const captures = server.getCaptures('multi-turn');
  assert.deepEqual(captures.map((capture) => [capture.turn, capture.attempt]), [[0, 0], [1, 0]]);
});

test('startup phase classifies catalog GET as probe and never labels business POST as probe', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  const probe = await request(`${server.url}/v1/models`);
  assert.equal(probe.status, 200);
  const business = await postJson(`${server.url}/v1/chat/completions`, { model: 'mock.chat-model' });
  assert.equal(business.status, 400);
  assert.equal(business.json.error, 'mock_provider_no_active_case');
  const unknown = await request(`${server.url}/nope`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'mock_provider_unknown_contract');

  const captures = server.getCaptures();
  assert.equal(captures.length, 3);
  assert.equal(captures[0].attempt_kind, 'probe');
  assert.equal(captures[0].case_id, null);
  assert.equal(captures[0].response_script.mode, 'probe');
  // Red control: a POST to a business path is a business attempt, not a probe.
  assert.equal(captures[1].attempt_kind, 'business');
  assert.notEqual(captures[1].attempt_kind, 'probe');
  assert.equal(captures[1].case_id, null);
  assert.equal(captures[1].attempt, null);
  assert.equal(captures[2].attempt_kind, 'unknown');
});

test('explicit probe classifier hook classifies only non-business paths', async (t) => {
  const server = await startMockProvider({ isProbe: ({ path }) => path === '/custom/probe' });
  t.after(() => server.close());
  const custom = await request(`${server.url}/custom/probe`);
  assert.equal(custom.status, 200);
  // The hook must not be allowed to reclassify a known business path.
  const business = await postJson(`${server.url}/v1/chat/completions`, { model: 'mock.chat-model' });
  assert.equal(business.status, 400);
  assert.equal(business.json.error, 'mock_provider_no_active_case');
  const captures = server.getCaptures();
  assert.equal(captures[0].attempt_kind, 'probe');
  assert.equal(captures[1].attempt_kind, 'business');
  assert.notEqual(captures[1].attempt_kind, 'probe');
});

test('invalid fixtures fail explicitly as mock facility errors', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  assert.throws(() => server.setActiveCase({ case_id: 'x' }), (error) => error instanceof MockProviderError && error.code === 'mock_invalid_fixture');
  server.setActiveCase(fixture({ case_id: 'bad-path', cell: { provider_protocol: 'anthropic' } }));
  const mismatch = await postJson(`${server.url}/v1/chat/completions`, {});
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error, 'mock_provider_contract_mismatch');
});

test('close() retains captures and releases the listener', async (t) => {
  const server = await startMockProvider();
  server.setActiveCase(fixture({ case_id: 'close-case' }));
  const ok = await postJson(`${server.url}/v1/chat/completions`, { ok: true });
  assert.equal(ok.status, 200);
  await server.close();
  assert.equal(server.getCaptures('close-case').length, 1);
  const after = await postJson(`${server.url}/v1/chat/completions`, { ok: true });
  assert.ok(after.error, 'closed listener must not accept new requests');
});

test('executes real corpus fault, [DONE], attempts, and multi-turn scripts', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());

  const faultCase = readCase('provider-fault-stream-cut');
  server.setActiveCase(faultCase);
  const faultProviderPath = faultCase.expected_provider.paths[0];
  const cut = await postJson(`${server.url}${faultProviderPath}`, faultCase.client_request.body, faultCase.client_request.headers);
  assert.equal(cut.status, 200);
  assert.equal(cut.bytes.length, faultCase.upstream_response.close_after_bytes);
  assert.ok(cut.bodyText.includes('chatcmpl_cut'));
  const recovered = await postJson(`${server.url}${faultProviderPath}`, faultCase.client_request.body, faultCase.client_request.headers);
  assert.deepEqual(recovered.json, faultCase.upstream_response.attempts[1].body);
  const faultCaptures = server.getCaptures('provider-fault-stream-cut');
  assert.deepEqual(faultCaptures.map((capture) => capture.response_script.kind ?? capture.response_script.mode), ['fault', 'json']);

  const followupCase = readCase('tool-followup-responses-to-chat');
  server.setActiveCase(followupCase);
  const followupProviderPath = followupCase.expected_provider.paths[0];
  const firstTurn = await postJson(`${server.url}${followupProviderPath}`, followupCase.client_request.body, followupCase.client_request.headers);
  assert.ok(firstTurn.bodyText.endsWith('data: [DONE]\n\n'), 'real corpus [DONE] must be raw');
  assert.ok(!firstTurn.bodyText.includes('"[DONE]"'));
  server.setTurn(1);
  const secondTurn = await postJson(`${server.url}${followupProviderPath}`, followupCase.turns[1].client_request.body, followupCase.turns[1].client_request.headers);
  assert.deepEqual(secondTurn.json, followupCase.turns[1].upstream_response.body);
});

test('advanceTurnAfterResponse moves a real client to its follow-up turn atomically', async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  const multiTurn = fixture({
    case_id: 'atomic-turn-transition',
    turns: [
      {
        upstream_response: {
          protocol: 'openai_chat',
          mode: 'json',
          status: 200,
          content_type: 'application/json',
          body: { turn: 'tool-call' },
        },
      },
      {
        upstream_response: {
          protocol: 'openai_chat',
          mode: 'json',
          status: 200,
          content_type: 'application/json',
          body: { turn: 'follow-up' },
        },
      },
    ],
  });
  server.setActiveCase(multiTurn, 0);
  server.advanceTurnAfterResponse(multiTurn.case_id, 0, 1);
  const url = `${server.url}/v1/chat/completions`;
  assert.deepEqual((await postJson(url, { request: 1 })).json, { turn: 'tool-call' });
  assert.deepEqual((await postJson(url, { request: 2 })).json, { turn: 'follow-up' });
  assert.deepEqual(server.getCaptures(multiTurn.case_id).map((capture) => capture.turn), [0, 1]);
});

test('every real corpus provider path is served by the mock', async (t) => {
  const manifest = JSON.parse(readFileSync(join(caseRoot, '..', 'manifest.json'), 'utf8'));
  const server = await startMockProvider();
  t.after(() => server.close());
  for (const caseId of manifest.cases) {
    const corpusCase = readCase(caseId);
    server.setActiveCase(corpusCase);
    const providerPath = corpusCase.expected_provider.paths[0];
    const script = corpusCase.upstream_response;
    const controlledAttempt = script.attempts?.[0];
    const frameScript = controlledAttempt?.fault === 'hold-open-controlled' ? controlledAttempt : script;
    const heldOpen = script.fault === 'hold-open' || script.fault === 'hold-open-controlled';
    const result = heldOpen
      ? await observeScriptPrefix(`${server.url}${providerPath}`, { smoke: caseId }, firstRawFrame(frameScript))
      : await postJson(`${server.url}${providerPath}`, { smoke: caseId });
    if (script.fault === 'hold-open-controlled') await server.releaseHeld(caseId);
    assert.ok(result.status >= 200 && result.status < 600, `${caseId} got status ${result.status} for ${providerPath}`);
    if (heldOpen) {
      assert.equal(result.status, script.status);
      assert.equal(result.headers['content-type'], script.content_type);
      assert.equal(result.prefixObserved, true);
      assert.equal(result.ended, false, 'prefix observation is not a completed response');
    }
    assert.ok(
      !result.json?.error || typeof result.json.error !== 'string' || !result.json.error.startsWith('mock_'),
      `${caseId} returned a facility error: ${result.bodyText}`,
    );
    const captures = server.getCaptures(caseId);
    assert.equal(captures.length, 1);
    const expectedUrl = new URL(providerPath, server.url);
    assert.equal(captures[0].method, 'POST');
    assert.equal(captures[0].path, expectedUrl.pathname);
    assert.equal(captures[0].query, expectedUrl.search);
  }
});

test('prefix observation closes its own held-open connection and never accepts a missing prefix', { timeout: 4000 }, async (t) => {
  const server = await startMockProvider();
  t.after(() => server.close());
  const corpusCase = readCase('gemini-json-sse-budget-before-terminal');
  const prefix = firstRawFrame(corpusCase.upstream_response);
  server.setActiveCase(corpusCase);
  const url = `${server.url}${corpusCase.expected_provider.paths[0]}`;
  const observed = await observeScriptPrefix(url, { smoke: corpusCase.case_id }, prefix);
  assert.equal(observed.status, 200);
  assert.equal(observed.prefixObserved, true);
  assert.equal(observed.ended, false);
  await assert.rejects(observeScriptPrefix(url, { smoke: corpusCase.case_id }, `${corpusCase.upstream_response.sse_events[0].raw}missing-frame`, 50), /deadline expired/);
  assert.equal(server.getCaptures(corpusCase.case_id).length, 2);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}
