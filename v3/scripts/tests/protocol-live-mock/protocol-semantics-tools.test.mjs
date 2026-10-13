import assert from 'node:assert/strict';
import test from 'node:test';

import { assertClientResult } from './assertions.mjs';
import {
  parseClientBody,
  findSemanticTerminal,
} from './protocol-semantics.mjs';
import {
  rawSseText,
  sseFrame,
} from './protocol-semantics-test-support.mjs';

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
