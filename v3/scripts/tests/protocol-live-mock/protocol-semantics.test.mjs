import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertClientResult } from './assertions.mjs';
import {
  SUPPORTED_PROTOCOLS,
  parseClientBody,
  parseSse,
  findSemanticTerminal,
} from './protocol-semantics.mjs';

function frame(event, data) {
  const rawData = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${rawData}\n\n`;
}

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

test('protocol semantics module is import-safe and exposes the suite protocols', () => {
  assert.deepEqual(SUPPORTED_PROTOCOLS, ['openai_chat', 'responses', 'anthropic', 'gemini']);
});

test('parseSse preserves ordered frames and SSE transport shapes', async (t) => {
  await t.test('CRLF, LF, comments, multiline data, data-less events, and raw [DONE]', () => {
    const text = [
      ': keep-alive',
      'event: first',
      'data: {"value": 1}',
      '',
      'data: {"value": 2}',
      '',
      'event: second',
      'data: {"value": 3}',
      '',
      'event: message_stop',
      '',
      'event: message',
      'data: [DONE]',
      '',
    ].join('\r\n');
    const frames = parseSse(text);
    assert.deepEqual(frames, [
      { event: 'first', data: { value: 1 }, raw_data: '{"value": 1}' },
      { event: 'message', data: { value: 2 }, raw_data: '{"value": 2}' },
      { event: 'second', data: { value: 3 }, raw_data: '{"value": 3}' },
      { event: 'message_stop', data: '', raw_data: '' },
      { event: 'message', data: '[DONE]', raw_data: '[DONE]' },
    ]);
    assert.equal(typeof frames[4].data, 'string');
    assert.equal(frames[4].data, '[DONE]');
  });

  await t.test('multiline data joins with a newline and is parsed as one JSON object', () => {
    const text = 'event: chunk\ndata: {"candidates": [\ndata: {"finishReason": "STOP"}]}\n\n';
    const frames = parseSse(text);
    assert.deepEqual(frames, [
      {
        event: 'chunk',
        data: { candidates: [{ finishReason: 'STOP' }] },
        raw_data: '{"candidates": [\n{"finishReason": "STOP"}]}',
      },
    ]);
  });

  await t.test('truncated data is a raw literal and is not repaired', () => {
    const frames = parseSse('event: chunk\ndata: {"candidates": [\n');
    assert.deepEqual(frames, [
      { event: 'chunk', data: '{"candidates": [', raw_data: '{"candidates": [' },
    ]);
  });
});

test('parseClientBody keeps JSON, SSE, malformed, and unknown content separate', () => {
  const json = parseClientBody('openai_chat', '{"choices": []}', 'application/json');
  assert.deepEqual(json, {
    protocol: 'openai_chat',
    kind: 'json',
    content_type: 'application/json',
    ok: true,
    body: { choices: [] },
    semantic: { choices: [] },
  });

  const sse = parseClientBody('responses', 'event: response.completed\ndata: {"type":"response.completed"}\n\n', 'text/event-stream');
  assert.equal(sse.kind, 'sse');
  assert.equal(sse.ok, true);
  assert.equal(sse.frames.length, 1);

  assert.deepEqual(parseClientBody('responses', '{"finish_reason":', 'application/json'), {
    protocol: 'responses',
    kind: 'error',
    content_type: 'application/json',
    ok: false,
    error: 'malformed_json',
  });
  assert.deepEqual(parseClientBody('gemini', 'not a protocol body', 'text/plain'), {
    protocol: 'gemini',
    kind: 'unknown',
    content_type: 'text/plain',
    ok: false,
    error: 'unknown_content_type',
  });
});

test('findSemanticTerminal accepts valid JSON terminals for all four protocols', () => {
  const cases = [
    ['openai_chat', { choices: [{ finish_reason: 'stop' }] }],
    ['openai_chat', { choices: [{ finish_reason: 'length' }] }],
    ['openai_chat', { choices: [{ finish_reason: 'content_filter' }] }],
    ['responses', { status: 'completed', output: [] }],
    ['responses', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }],
    ['anthropic', { stop_reason: 'end_turn' }],
    ['gemini', { candidates: [{ finishReason: 'STOP' }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }],
  ];

  for (const [protocol, body] of cases) {
    assert.equal(
      findSemanticTerminal(protocol, body, JSON.stringify(body)),
      true,
      protocol,
    );
  }
});

test('findSemanticTerminal accepts valid SSE terminals for all four protocols', () => {
  const cases = [
    ['openai_chat', frame('chunk', { choices: [{ delta: {}, finish_reason: 'stop' }] })],
    ['responses', frame('response.completed', { type: 'response.completed', response: { status: 'completed' } })],
    ['anthropic', frame('message_stop', { type: 'message_stop' })],
    ['gemini', frame('candidate', { candidates: [{ finishReason: 'STOP' }] })],
  ];

  for (const [protocol, bodyText] of cases) {
    assert.equal(findSemanticTerminal(protocol, null, bodyText), true, protocol);
  }
});

test('findSemanticTerminal rejects marker text in content', () => {
  const chatJson = {
    choices: [{ message: { role: 'assistant', content: 'finish_reason is a marker' }, finish_reason: null }],
  };
  assert.equal(findSemanticTerminal('openai_chat', chatJson, JSON.stringify(chatJson)), false);

  const responsesJson = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'response.completed' }] }] };
  assert.equal(findSemanticTerminal('responses', responsesJson, JSON.stringify(responsesJson)), false);

  const anthropicSse = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"message_stop"}}\n\n';
  assert.equal(findSemanticTerminal('anthropic', null, anthropicSse), false);

  const geminiJson = { candidates: [{ content: { parts: [{ text: 'finishReason' }] } }] };
  assert.equal(findSemanticTerminal('gemini', geminiJson, JSON.stringify(geminiJson)), false);
});

test('findSemanticTerminal rejects malformed and truncated observations', () => {
  const inputs = [
    ['openai_chat', '{"choices":[{"finish_reason":'],
    ['responses', '{"status":"completed"'],
    ['anthropic', 'event: message_stop\ndata: {"type":"message_stop"'],
    ['gemini', '{"candidates":[{"finishReason":"STOP"'],
  ];

  for (const [protocol, bodyText] of inputs) {
    assert.equal(findSemanticTerminal(protocol, null, bodyText), false, protocol);
  }

  assert.deepEqual(parseClientBody('openai_chat', '{"choices":[{"finish_reason":', 'application/json'), {
    protocol: 'openai_chat',
    kind: 'error',
    content_type: 'application/json',
    ok: false,
    error: 'malformed_json',
  });
});

test('findSemanticTerminal never converts provider error frames into terminals', () => {
  const chatError = 'event: error\ndata: {"type":"error","message":"finish_reason"}\n\n';
  assert.equal(findSemanticTerminal('openai_chat', null, chatError), false);

  const responsesError = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n';
  assert.equal(findSemanticTerminal('responses', null, responsesError), false);

  const anthropicError = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n';
  assert.equal(findSemanticTerminal('anthropic', null, anthropicError), false);

  const geminiError = 'event: error\ndata: {"error":{"status":"RESOURCE_EXHAUSTED"}}\n\n';
  assert.equal(findSemanticTerminal('gemini', null, geminiError), false);
});

test('JSON content type selects JSON parsing and malformed JSON is not repaired', () => {
  const bodyText = '{"stop_reason":"end_turn"}';
  assert.equal(parseClientBody('anthropic', bodyText, 'application/json').kind, 'json');
  assert.deepEqual(parseClientBody('anthropic', bodyText, 'application/json').body, { stop_reason: 'end_turn' });
  assert.equal(findSemanticTerminal('anthropic', null, bodyText), true);
  assert.deepEqual(parseClientBody('anthropic', '{"stop_reason":', 'application/json'), {
    protocol: 'anthropic',
    kind: 'error',
    content_type: 'application/json',
    ok: false,
    error: 'malformed_json',
  });
  assert.equal(findSemanticTerminal('anthropic', null, '{"stop_reason":'), false);
});

test('SSE tool fragments stay ordered and are never concatenated into a synthetic terminal', () => {
  const text = [
    frame('chunk', { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { arguments: '{"x":' } }] } }] }),
    frame('chunk', { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', function: { arguments: '{"y":' } }] } }] }),
    frame('chunk', { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    frame('chunk', { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] }),
    frame('message', '[DONE]'),
  ].join('');

  const frames = parseSse(text);
  assert.equal(frames.length, 5);
  assert.equal(frames[0].data.choices[0].delta.tool_calls[0].id, 'call_a');
  assert.equal(frames[1].data.choices[0].delta.tool_calls[0].id, 'call_b');
  assert.equal(frames[2].raw_data.includes('call_a'), false);
  assert.equal(frames[3].raw_data.includes('call_b'), false);
  assert.equal(frames[4].data, '[DONE]');
  assert.equal(findSemanticTerminal('openai_chat', null, text), false);
});

test('raw [DONE] alone never proves a semantic terminal', () => {
  const text = 'data: [DONE]\n\n';
  const frames = parseSse(text);
  assert.equal(frames[0].data, '[DONE]');
  assert.equal(findSemanticTerminal('openai_chat', null, text), false);
  assert.equal(parseClientBody('openai_chat', text, '').kind, 'sse');
});

test('unknown protocol and unknown content type have no semantic fallback', () => {
  assert.equal(findSemanticTerminal('unknown_protocol', { status: 'completed' }, '{"status":"completed"}'), false);
  assert.equal(parseClientBody('anthropic', '{"stop_reason":"end_turn"}', 'application/x-something').kind, 'unknown');
});

const fixturePath = (name) => new URL(`../../../fixtures/protocol-live-mock-matrix/cases/${name}`, import.meta.url);

function rawSseText(events) {
  return events.map((entry) => {
    const lines = [];
    if (entry.event !== undefined) lines.push(`event: ${entry.event}`);
    lines.push(`data: ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}`);
    return `${lines.join('\n')}\n\n`;
  }).join('');
}

function loadSseFixture(name) {
  const fixture = JSON.parse(readFileSync(fixturePath(name), 'utf8'));
  return {
    raw: rawSseText(fixture.upstream_response.sse_events),
    expected: fixture.expected_client,
  };
}

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

function sseFrame(event, data) {
  return { event, data };
}

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

test('semantic observations expose response item arguments from actual events only', () => {
  const frames = [
    sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'echo', arguments: '' } }),
    sseFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_1', delta: '{"text":' }),
    sseFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_1', delta: '"ping"}' }),
    sseFrame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_1', arguments: '{"text":"ping"}' }),
    sseFrame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'echo', arguments: '{"text":"ping"}' }] } }),
  ];
  const raw = rawSseText(frames);
  const parsed = parseClientBody('responses', raw, 'text/event-stream');
  const expected = {
    transport: 'complete',
    status: 200,
    body_must: {
      status: 'completed',
      'item.type': 'function_call',
      'item.call_id': 'call_1',
      'item.name': 'echo',
      'item.arguments': '{"text":"ping"}',
    },
    semantic_terminal_required: true,
  };
  const ok = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: raw,
    observation: parsed,
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, expected, 'responses', { parseClientBody, findSemanticTerminal });
  assert.deepEqual(ok, { ok: true, diagnostics: [] });

  const alteredRaw = rawSseText(frames.map((frame) => {
    if (frame.data?.type === 'response.function_call_arguments.delta') {
      return { ...frame, data: { ...frame.data, delta: frame.data.delta.replace('ping', 'pong') } };
    }
    if (frame.data?.arguments === '{"text":"ping"}') {
      return { ...frame, data: { ...frame.data, arguments: '{"text":"pong"}' } };
    }
    if (frame.data?.response?.output?.[0]?.arguments === '{"text":"ping"}') {
      const output = frame.data.response.output.map((item) => (
        item.arguments === '{"text":"ping"}' ? { ...item, arguments: '{"text":"pong"}' } : item
      ));
      return { ...frame, data: { ...frame.data, response: { ...frame.data.response, output } } };
    }
    return frame;
  }));
  const altered = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: alteredRaw,
    observation: parseClientBody('responses', alteredRaw, 'text/event-stream'),
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, expected, 'responses', { parseClientBody, findSemanticTerminal });
  assert.equal(altered.ok, false);
  assert.ok(altered.diagnostics.includes('client body_must item.arguments mismatch'));
});

test('responses SSE coalesces repeated function_call snapshots by call_id without duplicating the call', () => {
  const raw = rawSseText([
    sseFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_echo_1',
        name: 'echo',
        arguments: '',
      },
    }),
    sseFrame('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      call_id: 'call_echo_1',
      arguments: '{"text":"ping"}',
    }),
    sseFrame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_echo_1',
        name: 'echo',
        arguments: '{"text":"ping"}',
      },
    }),
    sseFrame('response.completed', {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call_echo_1',
          name: 'echo',
          arguments: '{"text":"ping"}',
        }],
      },
    }),
  ]);
  const parsed = parseClientBody('responses', raw, 'text/event-stream');

  assert.deepEqual(parsed.semantic.output_items, [{
    type: 'function_call',
    call_id: 'call_echo_1',
    name: 'echo',
    arguments: '{"text":"ping"}',
  }]);
  assert.deepEqual(parsed.semantic.item, {
    type: 'function_call',
    call_id: 'call_echo_1',
    name: 'echo',
    arguments: '{"text":"ping"}',
  });
});

test('semantic observations do not invent missing terminals or complete arguments', () => {
  const raw = rawSseText([
    sseFrame(undefined, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_incomplete', function: { name: 'echo', arguments: '{"text":' } }] } }] }),
  ]);
  const incomplete = parseClientBody('openai_chat', raw, 'text/event-stream');
  assert.equal(incomplete.semantic.tool_calls[0].function.arguments, '{"text":');
  assert.equal(findSemanticTerminal('openai_chat', incomplete.semantic, raw), false);

  const missingTerminal = assertClientResult({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    bodyText: raw,
    observation: incomplete,
    error: null,
    aborted: false,
    truncated: false,
    complete: true,
    response_ended: true,
  }, {
    transport: 'complete',
    status: 200,
    body_must: { 'tool_calls.0.function.arguments': '{"text":' },
    semantic_terminal_required: true,
  }, 'openai_chat', { parseClientBody, findSemanticTerminal });
  assert.equal(missingTerminal.ok, false);
  assert.ok(missingTerminal.diagnostics.includes('semantic terminal missing from client output'));
});

test('responses SSE custom_tool_call retains exact raw input across split, structured, and interleaved items', async (t) => {
  await t.test('assembled custom input preserves exact whitespace and is exposed through the real assertion layer', () => {
    const first = '  {"q": ';
    const second = '"exact",\n';
    const third = '"n":\t7 }\n';
    const raw = rawSseText([
      sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'item_custom', call_id: 'call_custom', name: 'freeform' } }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'item_custom', delta: first }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'item_custom', delta: second }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'item_custom', delta: third }),
      sseFrame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [] } }),
    ]);
    const parsed = parseClientBody('responses', raw, 'text/event-stream');
    const assembled = first + second + third;
    const item = parsed.semantic.output_items[0];
    assert.equal(item.type, 'custom_tool_call');
    assert.equal(item.call_id, 'call_custom');
    assert.equal(item.name, 'freeform');
    assert.equal(item.input, assembled);
    assert.ok(item.input.includes('  {"q": '));
    assert.ok(item.input.includes('\t7 }\n'));
    assert.equal(item.arguments, undefined);

    const expected = {
      transport: 'complete',
      status: 200,
      body_must: {
        status: 'completed',
        'item.type': 'custom_tool_call',
        'item.call_id': 'call_custom',
        'item.name': 'freeform',
        'item.input': assembled,
      },
      semantic_terminal_required: true,
    };
    const ok = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: raw,
      observation: parsed,
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'responses', { parseClientBody, findSemanticTerminal });
    assert.deepEqual(ok, { ok: true, diagnostics: [] });

    const alteredRaw = raw.replace('\\t7 }\\n', '\\t8 }\\n');
    const altered = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: alteredRaw,
      observation: parseClientBody('responses', alteredRaw, 'text/event-stream'),
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'responses', { parseClientBody, findSemanticTerminal });
    assert.equal(altered.ok, false);
    assert.ok(altered.diagnostics.includes('client body_must item.input mismatch'));
  });

  await t.test('structured custom input is preserved verbatim and a complete done event replaces assembled fragments', () => {
    const structuredParsed = parseClientBody('responses', rawSseText([
      sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'item_custom', call_id: 'call_custom', name: 'freeform' } }),
      sseFrame('response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', output_index: 0, item_id: 'item_custom', input: { q: 'exact', nested: [1, 2] } }),
    ]), 'text/event-stream');
    assert.deepEqual(structuredParsed.semantic.output_items[0].input, { q: 'exact', nested: [1, 2] });

    const replacedParsed = parseClientBody('responses', rawSseText([
      sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'item_custom', call_id: 'call_custom', name: 'freeform' } }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: 'item_custom', delta: '{"partial":' }),
      sseFrame('response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', output_index: 0, item_id: 'item_custom', input: '  {"q":"exact"}\n' }),
    ]), 'text/event-stream');
    assert.equal(replacedParsed.semantic.output_items[0].input, '  {"q":"exact"}\n');
  });

  await t.test('interleaved custom and function items keep independent raw input, arguments, and call ordering', () => {
    const raw = rawSseText([
      sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_fn', call_id: 'call_fn', name: 'echo' } }),
      sseFrame('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'custom_tool_call', id: 'item_custom', call_id: 'call_custom', name: 'freeform' } }),
      sseFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_fn', delta: '{"text":"ping"}' }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 1, item_id: 'item_custom', delta: '  raw\n' }),
      sseFrame('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', output_index: 1, item_id: 'item_custom', delta: ' tail\t' }),
    ]);
    const parsed = parseClientBody('responses', raw, 'text/event-stream');
    const [fn, custom] = parsed.semantic.output_items;
    assert.equal(fn.type, 'function_call');
    assert.equal(fn.arguments, '{"text":"ping"}');
    assert.equal(fn.input, undefined);
    assert.equal(custom.type, 'custom_tool_call');
    assert.equal(custom.input, '  raw\n tail\t');
    assert.equal(custom.arguments, undefined);
    assert.deepEqual(parsed.semantic.output_items.map((item) => item.call_id), ['call_fn', 'call_custom']);
  });
});

test('anthropic SSE assembles independently split input_json_delta fragments and complete terminal forms', async (t) => {
  await t.test('split partial_json fragments assemble the exact raw tool_use input and satisfy the client assertion', () => {
    const f1 = '{"repo":"/tmp/pro';
    const f2 = 'ject","n": 2,';
    const f3 = '"deep":true}';
    const raw = rawSseText([
      sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } }),
      sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: f1 } }),
      sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: f2 } }),
      sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: f3 } }),
      sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseFrame('message_stop', { type: 'message_stop' }),
    ]);
    const parsed = parseClientBody('anthropic', raw, 'text/event-stream');
    const block = parsed.semantic.content[0];
    const assembled = f1 + f2 + f3;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'toolu_1');
    assert.equal(block.name, 'lookup');
    assert.equal(block.input, assembled);
    assert.equal(typeof block.input, 'string');
    assert.equal(JSON.parse(block.input).repo, '/tmp/project');

    const expected = {
      transport: 'complete',
      status: 200,
      body_must: { 'content.0.type': 'tool_use', 'content.0.id': 'toolu_1', 'content.0.name': 'lookup', 'content.0.input': assembled },
      semantic_terminal_required: true,
    };
    const ok = assertClientResult({
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
    assert.deepEqual(ok, { ok: true, diagnostics: [] });

    const droppedRaw = raw.replace(JSON.stringify(f2), JSON.stringify('{}'));
    const dropped = assertClientResult({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: droppedRaw,
      observation: parseClientBody('anthropic', droppedRaw, 'text/event-stream'),
      error: null,
      aborted: false,
      truncated: false,
      complete: true,
      response_ended: true,
    }, expected, 'anthropic', { parseClientBody, findSemanticTerminal });
    assert.equal(dropped.ok, false);
    assert.ok(dropped.diagnostics.includes('client body_must content.0.input mismatch'));
  });

  await t.test('complete and incomplete anthropic terminals remain recognized while raw frames stay intact', () => {
    const endTurn = rawSseText([
      sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      sseFrame('message_stop', { type: 'message_stop' }),
    ]);
    assert.equal(findSemanticTerminal('anthropic', parseClientBody('anthropic', endTurn, 'text/event-stream').semantic, endTurn), true);

    const toolUse = rawSseText([
      sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }),
      sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      sseFrame('message_stop', { type: 'message_stop' }),
    ]);
    const parsed = parseClientBody('anthropic', toolUse, 'text/event-stream');
    assert.equal(parsed.semantic.stop_reason, 'tool_use');
    assert.equal(findSemanticTerminal('anthropic', parsed.semantic, toolUse), true);
    assert.equal(parsed.frames[0].data.delta.partial_json, '{"x":1}');
    assert.equal(parsed.frames[2].data.type, 'message_stop');

    const incomplete = rawSseText([
      sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } }),
    ]);
    assert.equal(findSemanticTerminal('anthropic', parseClientBody('anthropic', incomplete, 'text/event-stream').semantic, incomplete), false);
  });
});
