import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProviderAttemptSequence,
  assertClientResult,
  assertProviderCaptures,
  deepEqual,
  resolvePath,
} from './assertions.mjs';
import { deepFreeze, providerCapture } from './assertions-test-support.mjs';

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
