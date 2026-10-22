import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_PROTOCOLS,
  parseClientBody,
  parseSse,
  findSemanticTerminal,
} from './protocol-semantics.mjs';
import { frame } from './protocol-semantics-test-support.mjs';

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

test('null Chat finish_reason is never a semantic terminal even with content, JSON completion or DONE', () => {
  const body = { object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: null }] };
  assert.equal(findSemanticTerminal('openai_chat', body, JSON.stringify(body)), false);
  const text = frame('chunk', { choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + frame('message', '[DONE]');
  assert.equal(findSemanticTerminal('openai_chat', null, text), false);
});

test('unknown protocol and unknown content type have no semantic fallback', () => {
  assert.equal(findSemanticTerminal('unknown_protocol', { status: 'completed' }, '{"status":"completed"}'), false);
  assert.equal(parseClientBody('anthropic', '{"stop_reason":"end_turn"}', 'application/x-something').kind, 'unknown');
});
