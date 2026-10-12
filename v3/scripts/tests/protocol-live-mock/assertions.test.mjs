import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProviderAttemptSequence,
  assertClientResult,
  assertProviderCaptures,
  deepEqual,
  resolvePath,
} from './assertions.mjs';
import { findSemanticTerminal, parseClientBody } from './protocol-semantics.mjs';

function providerCapture(overrides = {}) {
  const body = overrides.body ?? {
    model: 'chat-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };
  return {
    attempt_kind: 'business',
    method: 'POST',
    path: '/v1/chat/completions',
    query: '',
    headers: { authorization: 'Bearer sk-test' },
    body,
    raw_body: JSON.stringify(body),
    ...overrides,
    body,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Fields `lifecycle.sendHttp` always emits. A `transport=complete` check
// needs them; omitted fields are exactly what hid the Finding 1 false pass.
const COMPLETE_RECEIPT = Object.freeze({
  response_ended: true,
  complete: true,
  closed: false,
  aborted: false,
  truncated: false,
  error: null,
  error_detail: null,
});

test('Anthropic simple text representations compare without discarding any other meaning', () => {
  const body = { system: 'brief', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_original', name: 'echo', input: { text: 'original' } }] }] };
  const check = (actual) => assertProviderCaptures([providerCapture({ body: actual })], 0, { body_must: body }, { providerProtocol: 'anthropic' });
  const alternative = structuredClone(body);
  alternative.system = [{ type: 'text', text: 'brief' }];
  alternative.messages[0].content = [{ type: 'text', text: 'hello' }];
  assert.equal(check(deepFreeze(alternative)).ok, true);
  for (const mutation of [
    (b) => { b.messages[0].content[0].cache_control = { type: 'ephemeral' }; },
    (b) => { b.messages[0].content[0].text = 'lost'; },
    (b) => { b.messages[0].content.push({ type: 'image', source: { data: 'bytes' } }); },
    (b) => { b.messages[0].role = 'assistant'; },
    (b) => { b.messages.reverse(); },
    (b) => { delete b.messages[1].content[0].signature; },
    (b) => { b.messages[2].content[0].input.text = 'changed'; },
    (b) => { b.messages[2].content[0].id = 'wrong_pair'; },
  ]) {
    const changed = structuredClone(alternative);
    mutation(changed);
    assert.equal(check(changed).ok, false);
  }
});

test('Responses single leading system instruction equivalence preserves priority and ordered input', () => {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];
  const check = (body) => assertProviderCaptures([providerCapture({ body })], 0, { body_must: { instructions: 'brief', input } }, { providerProtocol: 'responses' });
  const prefix = { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'brief' }] };
  assert.equal(check({ input: [prefix, ...input] }).ok, true);
  for (const changed of [
    { input: [...input, prefix] },
    { input: [{ ...prefix, role: 'developer' }, ...input] },
    { input: [prefix, prefix, ...input] },
    { input: [{ ...prefix, content: [{ type: 'input_text', text: 'different' }] }, ...input] },
    { instructions: 'other', input: [prefix, ...input] },
    { previous_response_id: 'prior', input: [prefix, ...input] },
    { input: [prefix, { ...input[0], role: 'assistant' }] },
  ]) assert.equal(check(changed).ok, false);
});

test('resolvePath follows dotted keys and array indices without conflating null and missing', () => {
  const value = { usage: { total_tokens: null }, items: [{ text: 'a' }, { text: 'b' }] };
  assert.equal(resolvePath(value, 'usage.total_tokens'), null);
  assert.equal(resolvePath(value, 'usage.missing'), undefined);
  assert.equal(resolvePath(value, 'items.1.text'), 'b');
  assert.equal(resolvePath(value, ''), value);
  assert.equal(deepEqual(resolvePath(value, 'usage.missing'), null), false);
  assert.equal(deepEqual(resolvePath(value, 'usage.total_tokens'), null), true);
  assert.equal(deepEqual(0, null), false);
});

test('deepEqual is structural, ordered for arrays, and never coerces', () => {
  assert.equal(deepEqual({ a: [1, 2, 3] }, { a: [1, 2, 3] }), true);
  assert.equal(deepEqual({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2, 3] }), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(deepEqual(null, undefined), false);
});

test('provider exact and body_must subset expectations both pass', () => {
  const captures = [providerCapture()];
  const exact = { model: 'chat-model', messages: [{ role: 'user', content: 'hello' }], stream: false };

  const exactResult = assertProviderCaptures(captures, 0, {
    paths: ['/v1/chat/completions'],
    method: 'POST',
    auth_required: true,
    exact,
  }, { providerProtocol: 'openai_chat' });
  assert.deepEqual(exactResult, { ok: true, diagnostics: [] });

  const subsetResult = assertProviderCaptures(captures, 0, {
    paths: ['/v1/chat/completions'],
    method: 'POST',
    auth_required: true,
    body_must: { model: 'chat-model', 'messages.0.content': 'hello', stream: false },
  }, { providerProtocol: 'openai_chat' });
  assert.deepEqual(subsetResult, { ok: true, diagnostics: [] });
});

test('provider exact is strict and never accepts an array prefix', () => {
  const capture = providerCapture({ body: { items: [1, 2, 3] } });
  const result = assertProviderCaptures([capture], 0, {
    exact: { items: [1, 2] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((line) => line.includes('exact expected')));
});

test('wrong provider model, path, and arguments are caught', () => {
  const captures = [providerCapture()];

  const wrongModel = assertProviderCaptures(captures, 0, { body_must: { model: 'other-model' } });
  assert.equal(wrongModel.ok, false);
  assert.ok(wrongModel.diagnostics.some((line) => line.includes('body_must model mismatch')));

  const wrongPath = assertProviderCaptures(captures, 0, { paths: ['/v1/responses'] });
  assert.equal(wrongPath.ok, false);
  assert.ok(wrongPath.diagnostics.some((line) => line.includes('not in expected paths')));

  const wrongArgs = assertProviderCaptures(captures, 0, {
    body_must: { 'messages.0.content': 'goodbye' },
  });
  assert.equal(wrongArgs.ok, false);
  assert.ok(wrongArgs.diagnostics.some((line) => line.includes('messages.0.content mismatch')));
});

test('provider auth uses the protocol-native carrier and rejects empty credentials', () => {
  const cases = [
    { protocol: 'openai_chat', headers: { authorization: 'Bearer sk' }, ok: true },
    { protocol: 'openai_chat', headers: { authorization: 'Bearer ' }, ok: false },
    { protocol: 'openai_chat', headers: {}, ok: false },
    { protocol: 'openai_chat', headers: { 'x-api-key': 'sk' }, ok: false },
    { protocol: 'anthropic', headers: { 'x-api-key': 'sk' }, ok: true },
    { protocol: 'anthropic', headers: { 'x-api-key': '' }, ok: false },
    { protocol: 'gemini', headers: { 'x-goog-api-key': 'sk' }, ok: true },
    { protocol: 'gemini', headers: { 'x-api-key': 'sk' }, ok: false },
    { protocol: 'gemini', headers: {}, query: '?key=', ok: false },
    { protocol: 'gemini', headers: {}, query: '?key=sk-live', ok: true },
  ];
  for (const entry of cases) {
    const result = assertProviderCaptures(
      [providerCapture({ headers: entry.headers, query: entry.query ?? '' })],
      0,
      { auth_required: true },
      { providerProtocol: entry.protocol },
    );
    assert.equal(result.ok, entry.ok, `${entry.protocol} ${JSON.stringify(entry.headers)}`);
  }
});

test('provider forbidden rules and fake control leakage are caught', () => {
  const forbidden = assertProviderCaptures(
    [providerCapture({ body: { model: 'chat-model', metadata_center: { x: 1 } } })],
    0,
    { body_must_not: ['metadata_center'] },
  );
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.diagnostics.some((line) => line.includes('forbidden metadata_center')));

  const leakage = assertProviderCaptures(
    [providerCapture({ body: { model: 'chat-model', routecodex_internal: 'x' } })],
    0,
    {},
  );
  assert.equal(leakage.ok, false);
  assert.ok(leakage.diagnostics.some((line) => line.includes('control marker')));
});

test('startup and probe captures are excluded only by explicit attempt_kind', () => {
  const probe = providerCapture({ attempt_kind: 'probe', body: { model: 'wrong' } });
  const startup = providerCapture({ attempt_kind: 'startup', body: { model: 'wrong' } });
  const business = providerCapture();

  const result = assertProviderCaptures([probe, startup, business], 0, {
    body_must: { model: 'chat-model' },
  });
  assert.equal(result.ok, true);

  const missing = assertProviderCaptures([probe, business], 1, { body_must: { model: 'chat-model' } });
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((line) => line.includes('business attempt missing')));

  const unlabeled = providerCapture({ attempt_kind: undefined });
  const counted = assertProviderCaptures([unlabeled], 0, { body_must: { model: 'chat-model' } });
  assert.equal(counted.ok, true);
});

test('strict closed rejects HTTP 500, empty HTTP 200, and any received bytes', () => {
  const expected = { transport: 'closed', status: null };

  const error = assertClientResult({
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: { error: { type: 'rate_limit_error' } },
    bodyText: '{"error":{"type":"rate_limit_error"}}',
  }, expected, 'openai_chat');
  assert.equal(error.ok, false);

  const empty200 = assertClientResult({
    status: 200,
    headers: {},
    body: null,
    bodyText: '',
  }, expected, 'openai_chat');
  assert.equal(empty200.ok, false);
  assert.ok(empty200.diagnostics.some((line) => line.includes('received status 200')));

  const headersOnly = assertClientResult({
    status: null,
    headers: { 'content-type': 'application/json' },
    body: null,
    bodyText: '',
  }, expected, 'openai_chat');
  assert.equal(headersOnly.ok, false);
});

test('genuine socket close with no status or bytes satisfies expected closed', () => {
  const expected = { transport: 'closed', status: null };
  assert.deepEqual(
    assertClientResult({
      status: null,
      headers: {},
      body: null,
      bodyText: '',
      error: 'socket hang up',
    }, expected, 'openai_chat'),
    { ok: true, diagnostics: [] },
  );

  assert.deepEqual(
    assertClientResult({ closed: true, status: null, bodyText: '' }, expected, 'openai_chat'),
    { ok: true, diagnostics: [] },
  );
});

test('completion accepts whole-body JSON and keeps missing distinct from null and zero', () => {
  const body = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { total_tokens: null, completion_tokens: 0 },
  };
  const clientResult = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    bodyText: JSON.stringify(body),
    ...COMPLETE_RECEIPT,
  };

  const pass = assertClientResult(clientResult, {
    transport: 'complete',
    status: 200,
    body_must: { 'choices.0.message.content': 'ok', 'usage.total_tokens': null, 'usage.completion_tokens': 0 },
    semantic_terminal_required: true,
  }, 'openai_chat');
  assert.deepEqual(pass, { ok: true, diagnostics: [] });

  const missing = assertClientResult(clientResult, {
    transport: 'complete',
    status: 200,
    body_must: { 'usage.prompt_tokens': null },
  }, 'openai_chat');
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((line) => line.includes('usage.prompt_tokens missing')));

  const zeroIsNotNull = assertClientResult({
    ...clientResult,
    body: { usage: { total_tokens: 0 } },
  }, {
    transport: 'complete',
    status: 200,
    body_must: { 'usage.total_tokens': null },
  }, 'openai_chat');
  assert.equal(zeroIsNotNull.ok, false);
});

test('complete transport requires a clean sendHttp receipt, so matching bytes do not hide a failed transport', () => {
  const jsonBody = {
    id: 'chatcmpl_chat_direct_json',
    object: 'chat.completion',
    model: 'chat-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  };
  const expected = {
    transport: 'complete',
    status: 200,
    body_must: {
      'choices.0.message.content': 'ok',
      'choices.0.finish_reason': 'stop',
      'usage.prompt_tokens': 7,
    },
    semantic_terminal_required: true,
  };
  const complete = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: jsonBody,
    bodyText: JSON.stringify(jsonBody),
    response_ended: true,
    complete: true,
    closed: false,
    aborted: false,
    truncated: false,
    error: null,
    error_detail: null,
  };

  assert.deepEqual(assertClientResult(complete, expected, 'openai_chat'), { ok: true, diagnostics: [] });

  const reset = {
    ...complete,
    response_ended: false,
    complete: false,
    closed: true,
    aborted: true,
    error: 'socket hang up',
    error_detail: { name: 'Error', message: 'socket hang up', code: 'ECONNRESET' },
  };
  const resetResult = assertClientResult(reset, expected, 'openai_chat');
  assert.equal(resetResult.ok, false);
  assert.ok(resetResult.diagnostics.some((line) => line.includes('client transport error')));
  assert.ok(resetResult.diagnostics.some((line) => line.includes('aborted before completion')));
  assert.ok(resetResult.diagnostics.some((line) => line.includes('not complete')));
  assert.ok(resetResult.diagnostics.some((line) => line.includes('response end was not received')));
  assert.ok(resetResult.diagnostics.some((line) => line.includes('closed before completion')));

  const truncation = { ...complete, truncated: true, error: 'response exceeded maxBytes=1048576' };
  const truncationResult = assertClientResult(truncation, expected, 'openai_chat');
  assert.equal(truncationResult.ok, false);
  assert.ok(truncationResult.diagnostics.some((line) => line.includes('was truncated')));
});

test('complete SSE transport rejects an expected terminal followed by a timeout', () => {
  const streamBody = 'event: message\ndata: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n';
  const observation = { text: 'ok', finishReason: 'STOP' };
  const expected = {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok', finishReason: 'STOP' },
    semantic_terminal_required: true,
  };
  const receipt = {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: streamBody,
    observation,
    response_ended: true,
    complete: true,
    closed: false,
    aborted: false,
    truncated: false,
    error: null,
  };
  assert.deepEqual(assertClientResult(receipt, expected, 'gemini'), { ok: true, diagnostics: [] });

  const timeout = {
    ...receipt,
    response_ended: false,
    complete: false,
    closed: true,
    error: 'request timed out after 10000ms',
    error_detail: { name: 'Error', message: 'request timed out after 10000ms', code: 'ETIMEDOUT' },
  };
  const timeoutResult = assertClientResult(timeout, expected, 'gemini');
  assert.equal(timeoutResult.ok, false);
  assert.ok(timeoutResult.diagnostics.some((line) => line.includes('client transport error')));
  assert.ok(timeoutResult.diagnostics.some((line) => line.includes('closed before completion')));

  const openEnded = {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: streamBody,
    observation,
    response_ended: true,
    complete: false,
    closed: false,
    aborted: false,
    truncated: false,
    error: null,
  };
  const openEndedResult = assertClientResult(openEnded, expected, 'gemini');
  assert.equal(openEndedResult.ok, false);
  assert.ok(openEndedResult.diagnostics.some((line) => line.includes('not complete')));
});

test('adapters without a complete receipt record fail closed for a complete expectation', () => {
  const expected = { transport: 'complete', status: 200, body_must: { 'choices.0.message.content': 'ok' } };
  const body = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

  const noReceipt = assertClientResult({ status: 200, body }, expected, 'openai_chat');
  assert.equal(noReceipt.ok, false);
  assert.ok(noReceipt.diagnostics.some((line) => line.includes('not complete')));
  assert.ok(noReceipt.diagnostics.some((line) => line.includes('response end was not received')));

  const endedButNotComplete = assertClientResult({ status: 200, body, response_ended: true }, expected, 'openai_chat');
  assert.equal(endedButNotComplete.ok, false);
  assert.ok(endedButNotComplete.diagnostics.some((line) => line.includes('not complete')));
});

test('ordered arrays are exact: no prefix and no reordering pass', () => {
  const expected = { transport: 'complete', status: 200, body_must: { items: [1, 2] } };
  const exact = assertClientResult({
    status: 200,
    body: { items: [1, 2] },
    bodyText: '{"items":[1,2]}',
    ...COMPLETE_RECEIPT,
  }, expected, 'openai_chat');
  assert.equal(exact.ok, true);

  const reordered = assertClientResult({
    status: 200,
    body: { items: [2, 1] },
    bodyText: '{"items":[2,1]}',
    ...COMPLETE_RECEIPT,
  }, expected, 'openai_chat');
  assert.equal(reordered.ok, false);

  const prefix = assertClientResult({
    status: 200,
    body: { items: [1, 2, 3] },
    bodyText: '{"items":[1,2,3]}',
    ...COMPLETE_RECEIPT,
  }, expected, 'openai_chat');
  assert.equal(prefix.ok, false);
});

test('SSE body expectations inspect a parsed observation, not substrings of the stream', () => {
  const streamBody = 'event: message\ndata: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n';
  const observation = { text: 'ok', finishReason: 'STOP' };

  const pass = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: streamBody,
    observation,
    ...COMPLETE_RECEIPT,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok', finishReason: 'STOP' },
    semantic_terminal_required: true,
  }, 'gemini');
  assert.deepEqual(pass, { ok: true, diagnostics: [] });

  const lookalike = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: 'event: message\ndata: {"delta":"finishReason message_stop response.completed"}\n\n',
    observation: { text: 'finishReason message_stop response.completed' },
    ...COMPLETE_RECEIPT,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'finishReason message_stop response.completed' },
    semantic_terminal_required: true,
  }, 'gemini');
  assert.equal(lookalike.ok, false);
  assert.ok(lookalike.diagnostics.some((line) => line.includes('semantic terminal missing')));
});

test('incomplete SSE without a parsed observation cannot prove completion or body expectations', () => {
  const result = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok' },
    semantic_terminal_required: true,
  }, 'responses');
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((line) => line.includes('client body_must text missing')));
  assert.ok(result.diagnostics.some((line) => line.includes('semantic terminal missing')));
});

test('the protocol dependency wires parsed observation and semantic terminal', () => {
  const deps = {
    parseClientBody: () => ({ text: 'ok', status: 'completed' }),
    findSemanticTerminal: () => true,
  };
  const pass = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: 'event: response.completed\ndata: {}\n\n',
    ...COMPLETE_RECEIPT,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok', status: 'completed' },
    semantic_terminal_required: true,
  }, 'responses', deps);
  assert.deepEqual(pass, { ok: true, diagnostics: [] });

  const fail = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: 'event: response.output_text.delta\ndata: {}\n\n',
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok' },
    semantic_terminal_required: true,
  }, 'responses', {
    parseClientBody: () => ({ text: 'ok' }),
    findSemanticTerminal: () => false,
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.diagnostics.some((line) => line.includes('semantic terminal missing')));
});

test('the real protocol module wires whole-body JSON and SSE terminal detection', () => {
  const deps = { parseClientBody, findSemanticTerminal };

  const jsonBody = JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  const jsonPass = assertClientResult({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: null,
    bodyText: jsonBody,
    ...COMPLETE_RECEIPT,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { 'choices.0.message.content': 'ok' },
    semantic_terminal_required: true,
  }, 'openai_chat', deps);
  assert.deepEqual(jsonPass, { ok: true, diagnostics: [] });

  const terminalStream = 'event: message\ndata: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n';
  const incompleteStream = 'event: message\ndata: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n';
  assert.equal(findSemanticTerminal('gemini', null, terminalStream), true);
  assert.equal(findSemanticTerminal('gemini', null, incompleteStream), false);

  const ssePass = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: null,
    bodyText: terminalStream,
    observation: { text: 'ok', finishReason: 'STOP' },
    ...COMPLETE_RECEIPT,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok', finishReason: 'STOP' },
    semantic_terminal_required: true,
  }, 'gemini', deps);
  assert.deepEqual(ssePass, { ok: true, diagnostics: [] });
});

test('client forbidden fields and fake control leakage are caught', () => {
  const forbidden = assertClientResult({
    status: 200,
    body: { choices: [{ finish_reason: 'stop' }], provider_error: 'boom' },
    bodyText: '{"choices":[{"finish_reason":"stop"}],"provider_error":"boom"}',
  }, {
    transport: 'complete',
    status: 200,
    body_must_not: ['provider_error'],
  }, 'openai_chat');
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.diagnostics.some((line) => line.includes('forbidden provider_error')));

  const leakage = assertClientResult({
    status: 200,
    body: { choices: [{ finish_reason: 'stop' }], metadata_center: {} },
    bodyText: '{"choices":[{"finish_reason":"stop"}],"metadata_center":{}}',
  }, {
    transport: 'complete',
    status: 200,
    body_must_not: ['metadata_center'],
  }, 'openai_chat');
  assert.equal(leakage.ok, false);
  assert.ok(leakage.diagnostics.some((line) => line.includes('control marker metadata_center')));
});

test('a non-2xx completed response and a wrong terminal are rejected', () => {
  const non2xx = assertClientResult({
    status: 404,
    body: { error: 'not found' },
    bodyText: '{"error":"not found"}',
  }, { transport: 'complete', status: 200 }, 'openai_chat');
  assert.equal(non2xx.ok, false);

  const noTerminal = assertClientResult({
    status: 200,
    body: { choices: [{ index: 0, message: { content: 'partial' } }] },
    bodyText: '{"choices":[{"index":0,"message":{"content":"partial"}}]}',
  }, {
    transport: 'complete',
    status: 200,
    semantic_terminal_required: true,
  }, 'openai_chat');
  assert.equal(noTerminal.ok, false);
  assert.ok(noTerminal.diagnostics.some((line) => line.includes('semantic terminal missing')));
});

test('assertions never mutate actual or expected inputs', () => {
  const captures = deepFreeze([providerCapture()]);
  const providerExpected = deepFreeze({
    paths: ['/v1/chat/completions'],
    method: 'POST',
    auth_required: true,
    body_must: { model: 'chat-model' },
    body_must_not: ['metadata_center'],
  });
  const providerSnapshot = JSON.stringify({ captures, providerExpected });
  assertProviderCaptures(captures, 0, providerExpected, { providerProtocol: 'openai_chat' });
  assert.equal(JSON.stringify({ captures, providerExpected }), providerSnapshot);

  const clientResult = deepFreeze({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
    bodyText: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}',
  });
  const clientExpected = deepFreeze({
    transport: 'complete',
    status: 200,
    body_must: { 'choices.0.message.content': 'ok' },
    body_must_not: ['provider_error'],
    semantic_terminal_required: true,
  });
  const clientSnapshot = JSON.stringify({ clientResult, clientExpected });
  assertClientResult(clientResult, clientExpected, 'openai_chat');
  assert.equal(JSON.stringify({ clientResult, clientExpected }), clientSnapshot);
});

// --- assertProviderAttemptSequence -----------------------------------------

const MOCK_CHAT_A = 'Bearer fake-loopback-token-mock-chat-a';
const MOCK_CHAT_B = 'Bearer fake-loopback-token-mock-chat-b';

function authCapture(authorization, overrides = {}) {
  return providerCapture({ headers: { authorization }, ...overrides });
}

function sequenceExpected(overrides = {}) {
  return {
    method: 'POST',
    paths: ['/v1/chat/completions'],
    auth_required: true,
    body_must: { model: 'chat-model', 'messages.0.content': 'hello', stream: false },
    auth_orders: [
      [MOCK_CHAT_A, MOCK_CHAT_B],
      [MOCK_CHAT_B, MOCK_CHAT_A],
    ],
    ...overrides,
  };
}

test('provider attempt sequence accepts either declared order with the correct wire body', () => {
  const expected = sequenceExpected();

  const forward = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A), authCapture(MOCK_CHAT_B)],
    expected,
    { providerProtocol: 'openai_chat' },
  );
  assert.deepEqual(forward, { ok: true, diagnostics: [] });

  const reverse = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_B), authCapture(MOCK_CHAT_A)],
    expected,
    { providerProtocol: 'openai_chat' },
  );
  assert.deepEqual(reverse, { ok: true, diagnostics: [] });
});

test('provider attempt sequence rejects a repeated identity even when the second attempt is healthy', () => {
  const repeatA = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A), authCapture(MOCK_CHAT_A)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(repeatA.ok, false);
  assert.ok(repeatA.diagnostics.some((line) => line.includes('repeated provider auth identity')));
  assert.ok(repeatA.diagnostics.some((line) => line.includes('not an allowed order')));

  const repeatB = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_B), authCapture(MOCK_CHAT_B)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(repeatB.ok, false);
  assert.ok(repeatB.diagnostics.some((line) => line.includes('repeated provider auth identity')));
  assert.ok(repeatB.diagnostics.some((line) => line.includes('not an allowed order')));
});

test('provider attempt sequence rejects an unknown authorization identity', () => {
  const result = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A), authCapture('Bearer fake-loopback-token-mock-chat-c')],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((line) => line.includes('unknown provider auth identity')));
  assert.ok(result.diagnostics.some((line) => line.includes('not an allowed order')));
});

test('provider attempt sequence rejects missing and extra business attempts', () => {
  const missing = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((line) => line.includes('missing provider business attempt')));

  const extra = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A), authCapture(MOCK_CHAT_B), authCapture(MOCK_CHAT_A)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(extra.ok, false);
  assert.ok(extra.diagnostics.some((line) => line.includes('extra provider business attempt')));
});

test('provider attempt sequence excludes only explicitly labelled probe and startup captures', () => {
  const wrongProbe = providerCapture({
    attempt_kind: 'probe',
    headers: { authorization: 'Bearer unknown-probe-token' },
    body: { model: 'wrong-probe-model' },
  });
  const wrongStartup = providerCapture({
    attempt_kind: 'startup',
    headers: { authorization: 'Bearer unknown-startup-token' },
    body: { model: 'wrong-startup-model' },
  });

  const result = assertProviderAttemptSequence(
    [wrongProbe, authCapture(MOCK_CHAT_A), wrongStartup, authCapture(MOCK_CHAT_B)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.deepEqual(result, { ok: true, diagnostics: [] });

  const unlabeled = providerCapture({
    attempt_kind: undefined,
    headers: { authorization: 'Bearer unknown-unlabeled-token' },
    body: { model: 'wrong-unlabeled-model' },
  });
  const counted = assertProviderAttemptSequence(
    [unlabeled, authCapture(MOCK_CHAT_A), authCapture(MOCK_CHAT_B)],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(counted.ok, false);
  assert.ok(counted.diagnostics.some((line) => line.includes('extra provider business attempt')));
});

test('provider attempt sequence re-checks the wire body of every ordered attempt', () => {
  const secondWrong = authCapture(MOCK_CHAT_B, {
    body: { model: 'other-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
  });
  const result = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A), secondWrong],
    sequenceExpected(),
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((line) => line.includes('body_must model mismatch')));
});

test('provider attempt sequence requires a declared auth_orders contract', () => {
  const result = assertProviderAttemptSequence(
    [authCapture(MOCK_CHAT_A)],
    { method: 'POST' },
    { providerProtocol: 'openai_chat' },
  );
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((line) => line.includes('auth_orders')));
});

test('provider attempt sequence never mutates captures or expected', () => {
  const captures = deepFreeze([authCapture(MOCK_CHAT_A), authCapture(MOCK_CHAT_B)]);
  const expected = deepFreeze(sequenceExpected());
  const snapshot = JSON.stringify({ captures, expected });

  const result = assertProviderAttemptSequence(captures, expected, { providerProtocol: 'openai_chat' });
  assert.deepEqual(result, { ok: true, diagnostics: [] });
  assert.equal(JSON.stringify({ captures, expected }), snapshot);
});
