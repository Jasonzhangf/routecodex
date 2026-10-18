import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertClientResult, assertProviderCaptures } from './assertions.mjs';
import {
  parseClientBody,
  parseSse,
  findSemanticTerminal,
  deriveSemanticObservation,
} from './protocol-semantics.mjs';
import {
  frame,
  fixturePath,
  loadSseFixture,
} from './protocol-semantics-test-support.mjs';
import { extractToolCalls } from './tool-consumer.mjs';

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

test('Gemini SSE associates an unambiguous single candidate without inventing a wire index', () => {
  const bytes = [
    frame('message', { responseId: 'chatcmpl_test' }),
    frame('message', { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    frame('message', { candidates: [{ content: { role: 'model' } }] }),
    frame('message', { candidates: [{ index: 0 }] }),
    frame('message', { candidates: [{ finishReason: 'STOP' }] }),
    frame('message', { candidates: [{ index: 0 }] }),
  ].join('');
  const parsed = parseClientBody('gemini', bytes, 'text/event-stream');

  assert.equal(parsed.semantic.text, 'ok');
  assert.equal(parsed.semantic.finishReason, 'STOP');
  assert.deepEqual(parsed.semantic.candidates, [{
    index: 0,
    content: { role: 'model', parts: [{ text: 'ok' }] },
  }]);
  assert.equal(parsed.frames[1].data.candidates[0].content.parts[0].text, 'ok');
  assert.equal(parsed.frames[4].data.candidates[0].finishReason, 'STOP');

  const result = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: bytes,
    observation: parsed,
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ok', finishReason: 'STOP' },
    semantic_terminal_required: true,
  }, 'gemini', { parseClientBody, findSemanticTerminal });
  assert.deepEqual(result, { ok: true, diagnostics: [] });
});

test('Gemini SSE text and terminal negative controls rebuild from the changed bytes', () => {
  const textOnly = frame('message', { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  const terminalOnly = frame('message', { candidates: [{ finishReason: 'STOP' }] });
  const expected = { transport: 'complete', status: 200, body_must: { text: 'ok', finishReason: 'STOP' }, semantic_terminal_required: true };
  const check = (bodyText) => assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText,
    observation: parseClientBody('gemini', bodyText, 'text/event-stream'),
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, expected, 'gemini', { parseClientBody, findSemanticTerminal });

  const missingText = check(terminalOnly);
  assert.equal(missingText.ok, false);
  assert.ok(missingText.diagnostics.includes('client body_must text missing'));

  const wrongText = check(frame('message', { candidates: [{ content: { parts: [{ text: 'wrong' }] } }] }) + terminalOnly);
  assert.equal(wrongText.ok, false);
  assert.ok(wrongText.diagnostics.includes('client body_must text mismatch'));

  const wrongTerminal = check(textOnly + frame('message', { candidates: [{ finishReason: 'MAX_TOKENS' }] }));
  assert.equal(wrongTerminal.ok, false);
  assert.ok(wrongTerminal.diagnostics.includes('client body_must finishReason mismatch'));

  const missingTerminal = check(textOnly);
  assert.equal(missingTerminal.ok, false);
  assert.ok(missingTerminal.diagnostics.includes('semantic terminal missing from client output'));
});

test('Gemini SSE keeps explicit candidate identities isolated', () => {
  const bytes = [
    frame('message', { candidates: [{ index: 0, content: { parts: [{ text: 'zero' }] } }] }),
    frame('message', { candidates: [{ index: 1, content: { parts: [{ text: 'one' }] } }] }),
    frame('message', { candidates: [{ index: 0, content: { parts: [{ text: 'zero-two' }] } }] }),
    frame('message', { candidates: [{ index: 1, finishReason: 'STOP' }] }),
  ].join('');
  const parsed = parseClientBody('gemini', bytes, 'text/event-stream');

  assert.equal(parsed.semantic.text, 'one');
  assert.deepEqual(parsed.semantic.candidates, [
    { index: 0, content: { parts: [{ text: 'zero' }, { text: 'zero-two' }] } },
    { index: 1, content: { parts: [{ text: 'one' }] } },
  ]);

  const check = (text) => assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: bytes,
    observation: parsed,
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text },
    semantic_terminal_required: true,
  }, 'gemini', { parseClientBody, findSemanticTerminal });
  assert.equal(check('one').ok, true);
  assert.equal(check('zero').ok, false);
});

test('Gemini SSE leaves ambiguous indexless text unassigned in multi-candidate streams', () => {
  const bytes = [
    frame('message', { candidates: [{ index: 0, content: { parts: [{ text: 'zero' }] } }] }),
    frame('message', { candidates: [{ content: { parts: [{ text: 'ambiguous' }] } }] }),
    frame('message', { candidates: [{ index: 1, finishReason: 'STOP' }] }),
  ].join('');
  const parsed = parseClientBody('gemini', bytes, 'text/event-stream');

  assert.equal(parsed.semantic.text, undefined);
  assert.equal(parsed.semantic.finishReason, 'STOP');
  assert.equal(parsed.frames[1].data.candidates[0].content.parts[0].text, 'ambiguous');
  assert.deepEqual(parsed.semantic.candidates, [
    { index: 0, content: { parts: [{ text: 'zero' }] } },
    { content: { parts: [{ text: 'ambiguous' }] } },
  ]);

  const result = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: bytes,
    observation: parsed,
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { text: 'ambiguous', finishReason: 'STOP' },
    semantic_terminal_required: true,
  }, 'gemini', { parseClientBody, findSemanticTerminal });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes('client body_must text missing'));
});

test('Gemini SSE preserves ordered parts, signatures, tools, unknown fields, and usage', () => {
  const firstParts = [
    { text: 'analysis', thought: true, thoughtSignature: 'sig-1' },
    { text: 'ok', signature: 'sig-2' },
    { functionCall: { name: 'echo', args: { text: 'ping' } }, extra: { kept: true } },
    { unknownPart: 'kept', nested: { value: 1 } },
  ];
  const bytes = [
    frame('message', { candidates: [{ content: { role: 'model', parts: firstParts } }] }),
    frame('message', { candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
    frame('message', { candidates: [{ finishReason: 'STOP' }] }),
    frame('message', { usageMetadata: { promptTokenCount: 7 } }),
    frame('message', { usageMetadata: { candidatesTokenCount: 2 } }),
  ].join('');
  const frames = parseSse(bytes);
  const before = structuredClone(frames);
  const semantic = deriveSemanticObservation('gemini', frames);

  assert.deepEqual(frames, before);
  assert.equal(semantic.text, 'okdone');
  assert.deepEqual(semantic.candidates[0].content.parts, [...firstParts, { text: 'done' }]);
  assert.deepEqual(semantic.usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 2 });
  assert.deepEqual(extractToolCalls('gemini', { bodyText: bytes, headers: { 'content-type': 'text/event-stream' } }), [{
    id: undefined,
    name: 'echo',
    type: 'functionCall',
    arguments: { text: 'ping' },
  }]);
});

test('Gemini chat provider content fixtures require the exact text-part array', () => {
  for (const name of ['gemini-to-chat-json.json', 'gemini-to-chat-sse.json']) {
    const fixture = JSON.parse(readFileSync(fixturePath(name), 'utf8'));
    assert.deepEqual(fixture.expected_provider.body_must['messages.0.content'], [{ type: 'text', text: 'hello' }]);
    const capture = [{
      attempt_kind: 'business',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-loopback-token' },
      body: {
        model: 'chat-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        ...(name.endsWith('-sse.json') ? { stream: true } : {}),
      },
    }];
    assert.deepEqual(assertProviderCaptures(capture, 0, fixture.expected_provider, { providerProtocol: 'openai_chat' }), { ok: true, diagnostics: [] });
    for (const [label, content] of [
      ['wrong text', [{ type: 'text', text: 'bye' }]],
      ['missing text', [{ type: 'text' }]],
      ['extra part', [{ type: 'text', text: 'hello' }, { type: 'text', text: 'extra' }]],
      ['type change', ['hello']],
    ]) {
      const changed = structuredClone(capture);
      changed[0].body.messages[0].content = content;
      const result = assertProviderCaptures(changed, 0, fixture.expected_provider, { providerProtocol: 'openai_chat' });
      assert.equal(result.ok, false, `${name}: ${label}`);
      assert.ok(result.diagnostics.includes('provider body_must messages.0.content mismatch'), `${name}: ${label}`);
    }
  }
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
