import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  executeDeclaredEchoTool,
  extractToolCalls,
  runToolFollowup,
} from './tool-consumer.mjs';

const caseFixture = JSON.parse(readFileSync(new URL('../../../fixtures/protocol-live-mock-matrix/cases/tool-followup-responses-to-chat.json', import.meta.url), 'utf8'));

const declaredRequest = caseFixture.client_request;
const sseEchoResult = {
  status: 200,
  bodyText: [
    { type: 'response.output_item.added', item: { id: 'item_echo', type: 'function_call', call_id: 'call_echo_1', name: 'echo', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item_echo', delta: '{"text":"' },
    { type: 'response.function_call_arguments.delta', item_id: 'item_echo', delta: 'ping"}' },
    { type: 'response.output_item.done', item: { id: 'item_echo', type: 'function_call', call_id: 'call_echo_1', name: 'echo', arguments: '{"text":"ping"}' } },
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join(''),
  body: undefined,
};

test('extractToolCalls parses streamed Responses SSE fragments into one complete echo call', () => {
  assert.deepEqual(extractToolCalls('responses', sseEchoResult), [{
    id: 'call_echo_1',
    name: 'echo',
    arguments: '{"text":"ping"}',
    type: 'function_call',
  }]);
});

test('extractToolCalls preserves separate streamed arguments for parallel tool indices', () => {
  const bodyText = [
    { id: 'call_a', object: 'chat.completion.chunk', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'left', arguments: '{"left":"' } }] }}] },
    { id: 'call_a', object: 'chat.completion.chunk', choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'right', arguments: '{"right":"' } }] }}] },
    { id: 'call_a', object: 'chat.completion.chunk', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'two"}' } }] }}] },
    { id: 'call_a', object: 'chat.completion.chunk', choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'two"}' } }] }}] },
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n';

  assert.deepEqual(extractToolCalls('openai_chat', { status: 200, bodyText }), [
    { id: 'call_1', name: 'left', arguments: '{"left":"two"}', type: 'function' },
    { id: 'call_2', name: 'right', arguments: '{"right":"two"}', type: 'function' },
  ]);
});

test('executeDeclaredEchoTool uses actual arguments and rejects undeclared/non-echo/invalid calls', () => {
  assert.equal(executeDeclaredEchoTool({ request: declaredRequest, call: { id: 'call_x', name: 'echo', type: 'function_call', arguments: '{"text":"actual"}' } }), 'actual');
  assert.throws(() => executeDeclaredEchoTool({ request: declaredRequest, call: { id: 'call_x', name: 'undeclared', type: 'function_call', arguments: '{"text":"x"}' } }), /not declared/u);
  assert.throws(() => executeDeclaredEchoTool({ request: declaredRequest, call: { id: 'call_x', name: 'spawn_agent', namespace: 'collaboration', type: 'function_call', arguments: '{"message":"x"}' } }), /not declared/u);
  assert.throws(() => executeDeclaredEchoTool({ request: { body: { tools: [{ type: 'function', name: 'spawn_agent' }] } }, call: { id: 'call_x', name: 'spawn_agent', type: 'function_call', arguments: '{"message":"x"}' } }), /not an echo consumer/u);
  assert.throws(() => executeDeclaredEchoTool({ request: declaredRequest, call: { id: 'call_x', name: 'echo', type: 'function_call', arguments: '{"wrong":1}' } }), /exactly one text/u);
});

test('runToolFollowup executes exactly once from actual args and sends the next request', async () => {
  const actual = JSON.parse(JSON.stringify(caseFixture));
  actual.case_id = 'actual-args-gate';
  actual.tool_followup.input = { text: 'fixture-value' };
  actual.tool_followup.expected_output = 'fixture-value';
  const actualResult = { status: 200, body: { output: [{ type: 'function_call', call_id: 'call_actual', name: 'echo', arguments: '{"text":"actual"}' }] } };
  const sent = [];
  const result = await runToolFollowup({
    fixture: actual,
    firstResult: actualResult,
    sendTurn: async (request, turnIndex) => { sent.push({ request, turnIndex }); return { status: 200 }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].id, 'call_actual');
  assert.equal(result.executions[0].output, 'actual');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].turnIndex, 1);
  assert.deepEqual(sent[0].request.body.input.slice(-2), [
    { type: 'function_call', call_id: 'call_actual', name: 'echo', arguments: '{"text":"actual"}' },
    { type: 'function_call_output', call_id: 'call_actual', output: 'actual' },
  ]);
});

test('runToolFollowup does not fabricate a result when no tool call is observed', async () => {
  const sendTurn = () => { throw new Error('sendTurn must not run without an observed call'); };
  const result = await runToolFollowup({ fixture: caseFixture, firstResult: { status: 200, body: { output: [] } }, sendTurn });
  assert.equal(result.ok, false);
  assert.equal(result.executions.length, 0);
  assert.match(result.diagnostics.join('; '), /no observed echo tool call/u);
});

test('runToolFollowup does not execute undeclared/non-echo observed calls', async () => {
  const fixture = {
    cell: { entry_protocol: 'responses' },
    client_request: { body: { tools: [{ type: 'function', name: 'exec_command' }] } },
    tool_followup: { consumer: 'echo' },
    turns: [{ client_request: { body: { input: [] } } }, { client_request: { body: {} } }],
  };
  const firstResult = { status: 200, body: { output: [{ type: 'function_call', call_id: 'bad', name: 'exec_command', arguments: '{"text":"no"}' }] } };
  const sendTurn = () => { throw new Error('must not execute undeclared tool'); };
  const result = await runToolFollowup({ fixture, firstResult, sendTurn });
  assert.equal(result.ok, false);
  assert.equal(result.executions.length, 0);
  assert.match(result.diagnostics.join('; '), /not declared/u);
});

test('runToolFollowup does not mutate fixture or client request input', async () => {
  const before = JSON.stringify(caseFixture);
  await runToolFollowup({
    fixture: caseFixture,
    firstResult: sseEchoResult,
    sendTurn: async () => ({ status: 200 }),
  });
  assert.equal(JSON.stringify(caseFixture), before);
});

test('extractToolCalls does not use fixture expected_client as an execution source', () => {
  const result = { status: 200, body: { output: [{ type: 'function_call', call_id: 'from_body', name: 'echo', arguments: '{"text":"body"}' }] } };
  const calls = extractToolCalls('responses', result);
  assert.equal(calls[0].id, 'from_body');
  assert.equal(calls[0].arguments, '{"text":"body"}');
});

test('namespace fixture preserves observed identity without granting execution or aliases', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/protocol-live-mock-matrix/cases/namespace-custom-complete-args.json', import.meta.url), 'utf8'));
  const item = { type: 'function_call', call_id: 'actual_namespace', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"actual"}' };
  const [call] = extractToolCalls('responses', { body: { output: [item] } });
  assert.deepEqual(call, { id: 'actual_namespace', name: 'spawn_agent', namespace: 'collaboration', arguments: item.arguments, type: 'function_call' });
  assert.throws(() => executeDeclaredEchoTool({ request: fixture.client_request, call }), /not an echo consumer/u);
  assert.throws(() => executeDeclaredEchoTool({ request: fixture.client_request, call: { ...call, name: 'collaboration__spawn_agent', namespace: undefined } }), /not declared/u);
  const result = await runToolFollowup({ fixture, firstResult: { body: { output: [item] } }, sendTurn: () => assert.fail('namespace tool must not execute') });
  assert.equal(result.ok, false);
  assert.equal(result.executions.length, 0);
});

test('custom echo returns exact raw input and submits it without JSON wrapping', async () => {
  const fixture = structuredClone(caseFixture);
  fixture.turns[0].client_request.body.tools = [{ type: 'namespace', name: 'safe', tools: [{ type: 'custom', name: 'echo' }] }];
  const raw = '  {"text":"literal"}\n\t';
  const firstResult = { body: { output: [{ type: 'custom_tool_call', call_id: 'raw_call', name: 'echo', namespace: 'safe', input: raw }] } };
  const before = JSON.stringify({ fixture, firstResult });
  const [call] = extractToolCalls('responses', firstResult);
  assert.equal(call.arguments, raw);
  assert.equal(call.input, raw);
  assert.throws(() => executeDeclaredEchoTool({ request: fixture.turns[0].client_request, call: { ...call, namespace: 'other' } }), /not declared/u);
  assert.throws(() => executeDeclaredEchoTool({ request: fixture.turns[0].client_request, call: { ...call, type: 'function_call' } }), /type mismatch/u);
  assert.throws(() => executeDeclaredEchoTool({ request: fixture.turns[0].client_request, call: { ...call, input: undefined } }), /raw string input/u);
  let sent;
  const result = await runToolFollowup({ fixture, firstResult, sendTurn: async (request) => { sent = request; return { status: 200 }; } });
  assert.equal(result.ok, true);
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output, raw);
  assert.deepEqual(sent.body.input.slice(-2), [
    { type: 'custom_tool_call', call_id: 'raw_call', name: 'echo', namespace: 'safe', input: raw },
    { type: 'custom_tool_call_output', call_id: 'raw_call', output: raw },
  ]);
  assert.equal(JSON.stringify({ fixture, firstResult }), before);
});

test('omitted identity/input, malformed arguments and parallel calls never fabricate execution', async () => {
  const valid = { type: 'function_call', call_id: 'valid', name: 'echo', arguments: '{"text":"ok"}' };
  for (const output of [
    [{ ...valid, call_id: undefined }],
    [{ ...valid, arguments: undefined }],
    [{ ...valid, type: undefined }],
    [{ ...valid, arguments: '{"text":"unfinished' }],
    [valid, { ...valid, call_id: 'second' }],
  ]) {
    const result = await runToolFollowup({ fixture: caseFixture, firstResult: { body: { output } }, sendTurn: () => assert.fail('invalid call must not send') });
    assert.equal(result.ok, false);
    assert.equal(result.executions.length, 0);
    assert.equal(result.turnResults.length, 1);
    assert.equal(result.diagnostics.length, 1);
  }
});

test('provider Chat wire is not a Responses client fallback and raw errors are not tools', () => {
  assert.deepEqual(extractToolCalls('responses', {
    bodyText: caseFixture.upstream_response.sse_events.map((frame) => `data: ${JSON.stringify(frame.data)}\n\n`).join(''),
  }), []);
  assert.deepEqual(extractToolCalls('responses', { bodyText: 'not JSON', body: { output: [{ type: 'function_call', call_id: 'fake', name: 'echo', arguments: '{"text":"fake"}' }] } }), []);
  assert.deepEqual(extractToolCalls('responses', { body: { error: { message: 'provider failed' } } }), []);
});

test('send failure remains explicit and does not retry the echo execution', async () => {
  let sends = 0;
  const result = await runToolFollowup({ fixture: caseFixture, firstResult: sseEchoResult, sendTurn: async () => { sends += 1; throw new Error('transport closed'); } });
  assert.equal(result.ok, false);
  assert.equal(sends, 1);
  assert.equal(result.executions.length, 1);
  assert.deepEqual(result.diagnostics, ['transport closed']);
});
