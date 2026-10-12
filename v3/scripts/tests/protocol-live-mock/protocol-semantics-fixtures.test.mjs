import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertClientResult } from './assertions.mjs';
import {
  parseClientBody,
  findSemanticTerminal,
} from './protocol-semantics.mjs';
import {
  frame,
  fixturePath,
  loadSseFixture,
} from './protocol-semantics-test-support.mjs';

test('Responses message snapshots expose text once and retain complete content metadata', () => {
  const content = [{ type: 'output_text', text: 'first', annotations: [{ type: 'url_citation', url: 'https://example.com' }] }, { type: 'output_text', text: 'second' }];
  const item = { id: 'msg_snapshot', type: 'message', role: 'assistant', status: 'completed', content };
  const bytes = frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
    + frame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [item] } });
  const observed = parseClientBody('responses', bytes, 'text/event-stream');
  assert.equal(observed.semantic.text, 'firstsecond');
  assert.deepEqual(observed.semantic.output_items, [item]);
  const expected = { transport: 'complete', status: 200, body_must: { text: 'firstsecond', 'output_items.0': item }, semantic_terminal_required: true };
  const check = (bodyText) => assertClientResult({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyText, error: null, aborted: false, truncated: false, complete: true, response_ended: true }, expected, 'responses', { parseClientBody, findSemanticTerminal });
  assert.equal(check(bytes).ok, true);
  for (const changed of [
    { ...item, content: content.slice(1) },
    { ...item, content: content.map(({ annotations, ...part }) => part) },
    { ...item, role: 'user' },
    { type: 'output_text', text: 'firstsecond' },
  ]) {
    assert.equal(check(frame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [changed] } })).ok, false);
  }
});

test('Responses completion observes all output messages in order without duplicating text deltas', () => {
  const first = { id: 'msg_a', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a', annotations: [] }] };
  const second = { id: 'msg_b', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] };
  const bytes = frame('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_a', output_index: 0, delta: 'a' })
    + frame('response.output_item.done', { type: 'response.output_item.done', item: first, output_index: 0 })
    + frame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [first, second] } });
  const observed = parseClientBody('responses', bytes, 'text/event-stream');
  assert.equal(observed.semantic.text, 'ab');
  assert.deepEqual(observed.semantic.output_items, [first, second]);
});

test('Responses client SSE oracles require message text and Responses status', () => {
  for (const name of ['responses-to-chat-sse.json', 'responses-to-anthropic-sse.json', 'responses-to-gemini-sse.json']) {
    const fixture = JSON.parse(readFileSync(fixturePath(name), 'utf8'));
    const item = { id: 'msg_independent', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
    const check = (changed, status = 'completed') => assertClientResult({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyText: frame('response.completed', { type: 'response.completed', response: { status, output: [changed] } }), error: null, aborted: false, truncated: false, complete: true, response_ended: true }, fixture.expected_client, 'responses', { parseClientBody, findSemanticTerminal });
    assert.equal(check(item).ok, true, name);
    assert.equal(check({ ...item, content: [] }).ok, false, name);
    assert.equal(check({ type: 'output_text', text: 'ok' }).ok, false, name);
    assert.equal(check(item, 'incomplete').ok, false, name);
  }
});

test('Chat usage delta keeps the golden and rejects missing or changed usage', () => {
  const fixture = JSON.parse(readFileSync(fixturePath('chat-to-responses-sse.json'), 'utf8'));
  assert.equal(fixture.client_request.body.stream_options.include_usage, true);
  const bytes = frame('message', { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] });
  const check = (usage) => assertClientResult({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyText: bytes + (usage === undefined ? '' : frame('message', { choices: [], usage })), error: null, aborted: false, truncated: false, complete: true, response_ended: true }, fixture.expected_client, 'openai_chat', { parseClientBody, findSemanticTerminal });
  assert.equal(check({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }).ok, true);
  assert.equal(check().ok, false);
  assert.equal(check({ prompt_tokens: 0 }).ok, false);
});

test('semantic observations match fixture expectations through the real assertion layer', async (t) => {
  await t.test('openai_chat SSE derives text and terminal while preserving frames', () => {
    const { raw, expected } = loadSseFixture('chat-to-chat-sse.json');
    const parsed = parseClientBody('openai_chat', raw, 'text/event-stream');

    assert.equal(parsed.kind, 'sse');
    assert.equal(parsed.frames.length, 3);
    assert.equal(parsed.frames[0].data.choices[0].delta.content, 'ok');
    assert.deepEqual(parsed.semantic, {
      text: 'ok',
      finish_reason: 'stop',
      model: 'chat-model',
      message: { role: 'assistant', content: 'ok' },
    });

    const result = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'openai_chat', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(result, { ok: true, diagnostics: [] });

    const altered = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: { ...parsed, semantic: { ...parsed.semantic, text: 'different' } },
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'openai_chat', { parseClientBody, findSemanticTerminal });
    assert.equal(altered.ok, false);
    assert.ok(altered.diagnostics.includes('client body_must text mismatch'));
  });

  await t.test('interleaved openai_chat tool fragments retain identity and complete arguments', () => {
    const { raw, expected } = loadSseFixture('tool-followup-responses-to-chat.json');
    const parsed = parseClientBody('openai_chat', raw, 'text/event-stream');
    const toolCall = parsed.semantic.tool_calls[0];

    assert.equal(toolCall.id, 'call_echo_1');
    assert.equal(toolCall.function.name, 'echo');
    assert.equal(toolCall.function.arguments, '{"text":"ping"}');
    assert.deepEqual(parsed.semantic.item, {
      type: 'function_call',
      name: 'echo',
      call_id: 'call_echo_1',
      arguments: '{"text":"ping"}',
    });

    const result = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'openai_chat', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(result, { ok: true, diagnostics: [] });

    const altered = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, {
      ...expected,
      body_must: {
        'tool_calls.0.function.arguments': '{"text":"pong"}',
      },
    }, 'openai_chat', {
      parseClientBody,
      findSemanticTerminal,
    });
    assert.equal(altered.ok, false);
    assert.ok(altered.diagnostics.includes('client body_must tool_calls.0.function.arguments mismatch'));
  });

  await t.test('anthropic SSE derives text and stop reason while preserving frames', () => {
    const { raw, expected } = loadSseFixture('anthropic-to-anthropic-sse.json');
    const parsed = parseClientBody('anthropic', raw, 'text/event-stream');

    assert.equal(parsed.semantic.text, 'ok');
    assert.equal(parsed.semantic.stop_reason, 'end_turn');
    assert.equal(parsed.frames[1].data.delta.text, 'ok');

    const result = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'anthropic', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(result, { ok: true, diagnostics: [] });
  });

  await t.test('gemini SSE derives candidate text and finishReason', () => {
    const { raw, expected } = loadSseFixture('gemini-to-gemini-sse.json');
    const parsed = parseClientBody('gemini', raw, 'text/event-stream');

    assert.equal(parsed.semantic.text, 'ok');
    assert.equal(parsed.semantic.finishReason, 'STOP');
    assert.equal(parsed.semantic.candidate.content.parts[0].text, 'ok');

    const result = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'gemini', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(result, { ok: true, diagnostics: [] });
  });

  await t.test('responses event stream derives final item and summary keys', () => {
    const raw = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ].join('');
    const parsed = parseClientBody('responses', raw, 'text/event-stream');

    assert.equal(parsed.semantic.text, 'ok');
    assert.equal(parsed.semantic.status, 'completed');
    const result = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      observation: parsed,
      bodyText: raw,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, {
      transport: 'complete',
      status: 200,
      body_must: { text: 'ok', status: 'completed' },
      semantic_terminal_required: true,
    }, 'responses', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(result, { ok: true, diagnostics: [] });
  });
});
