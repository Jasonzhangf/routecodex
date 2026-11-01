import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeDeclaredEchoTool,
  executeDeclaredStructuredEchoTool,
  executeLocalNamespaceMock,
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

test('structured echo derives the result from text and keeps the complete argument object', () => {
  const request = {
    body: {
      tools: [
        {
          type: 'function',
          name: 'echo',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
    },
  };
  const call = {
    id: 'call_structured',
    name: 'echo',
    type: 'function_call',
    arguments: {
      text: 'ping',
      encrypted_content: 'structured-tool-argument-business-value',
      nested: { encrypted_content: 'nested-tool-argument-business-value' },
    },
  };
  assert.equal(
    executeDeclaredStructuredEchoTool({ request, call, entryProtocol: 'responses' }),
    'ping',
  );
  assert.deepEqual(call.arguments.encrypted_content, 'structured-tool-argument-business-value');
  assert.deepEqual(call.arguments.nested.encrypted_content, 'nested-tool-argument-business-value');
});

test('runToolFollowup executes exactly once from actual args and sends the next request', async () => {
  const actual = JSON.parse(JSON.stringify(caseFixture));
  actual.case_id = 'actual-args-gate';
  actual.tool_followup.input = { text: 'fixture-value' };
  // The declared expectation matches the value the observed call yields, so the
  // actual argument (not the fixture input) drives both execution and follow-up.
  actual.tool_followup.expected_output = 'actual';
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
  fixture.tool_followup.expected_output = raw;
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

const fixturePath = (name) => new URL(`../../../fixtures/protocol-live-mock-matrix/cases/${name}.json`, import.meta.url);
const loadFixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));
const jsonObserved = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body, bodyText: JSON.stringify(body) });
const sseFromFixture = (events) => events.map((event) => `data: ${JSON.stringify(event.data)}\n\n`).join('');

const namespaceFirstCall = {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  bodyText: [
    { type: 'response.output_item.added', item: { id: 'fc_ns_1', type: 'function_call', call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_ns_1', delta: '{"message":"do ' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_ns_1', delta: 'work"}' },
    { type: 'response.output_item.done', item: { id: 'fc_ns_1', type: 'function_call', call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"do work"}' } },
    { type: 'response.completed', response: { id: 'resp_ns_1', status: 'completed' } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
};

test('gemini echo-line-result consumer returns the full structured result and keeps the absent native id, the observed signature and the absent-role attachment wrapper', async () => {
  const fixture = loadFixture('gemini-native-root-fidelity-relay-json');
  const expectedOutput = fixture.tool_followup.expected_output;
  let sent;
  const result = await runToolFollowup({
    fixture,
    firstResult: jsonObserved(fixture.upstream_response.body),
    sendTurn: async (request) => { sent = request; return { status: 200 }; },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.equal(result.executions.length, 1);
  assert.deepEqual(result.executions[0], {
    id: undefined,
    name: 'echo',
    type: 'functionCall',
    arguments: { message: 'native-tool-result' },
    output: { output: 'native-tool-result\n', exitCode: 0 },
  });
  // The receipt is the actual function return and equals the literal expectation.
  assert.deepEqual(result.executions[0].output, expectedOutput);
  // The generated request is the declared second provider body, byte for byte.
  assert.deepEqual(sent.body, fixture.turns[1].expected_provider_exact);
  const [, model, response] = sent.body.contents;
  assert.equal(Object.prototype.hasOwnProperty.call(response, 'role'), false);
  assert.deepEqual(model.parts, [{ functionCall: { name: 'echo', args: { message: 'native-tool-result' } }, thoughtSignature: 'native-call-signature' }]);
  assert.equal(Object.prototype.hasOwnProperty.call(model.parts[0].functionCall, 'id'), false);
  assert.deepEqual(response.parts[0].functionResponse.response, result.executions[0].output);
  assert.deepEqual(response.parts[0].functionResponse, {
    name: 'echo',
    response: { output: 'native-tool-result\n', exitCode: 0 },
    parts: [
      { text: 'attachment note', thoughtSignature: 'attachment-signature' },
      { inlineData: { mimeType: 'image/png', data: 'UE5H' } },
    ],
  });
  assert.deepEqual(sent.body.safetySettings, fixture.turns[1].expected_provider_exact.safetySettings);
  assert.deepEqual(sent.body.toolConfig, fixture.turns[1].expected_provider_exact.toolConfig);
});

test('gemini echo consumer reads the declared parametersJsonSchema key and keeps the paired call id', async () => {
  const fixture = loadFixture('gemini-native-declaration-schema-relay-json');
  let sent;
  const result = await runToolFollowup({
    fixture,
    firstResult: jsonObserved(fixture.upstream_response.body),
    sendTurn: async (request) => { sent = request; return { status: 200 }; },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.equal(result.executions[0].id, 'call_schema_1');
  assert.equal(result.executions[0].output, 'native-tool-result');
  assert.deepEqual(sent.body, fixture.turns[1].expected_provider_exact);
});

test('echo-line-result ignores template response pollution in newline, exitCode and extra fields', async () => {
  const cleanOracle = loadFixture('gemini-native-root-fidelity-relay-json').turns[1].expected_provider_exact;
  const mutations = [
    (response) => { response.output = 'template-decoy\n'; },
    (response) => { response.exitCode = 7; },
    (response) => { response.extraBusiness = 'leak'; },
  ];
  for (const mutate of mutations) {
    const fixture = loadFixture('gemini-native-root-fidelity-relay-json');
    mutate(fixture.turns[1].client_request.body.contents[2].parts[0].functionResponse.response);
    const pollutedOracle = structuredClone(cleanOracle);
    mutate(pollutedOracle.contents[2].parts[0].functionResponse.response);
    let sent;
    const result = await runToolFollowup({
      fixture,
      firstResult: jsonObserved(fixture.upstream_response.body),
      sendTurn: async (request) => { sent = request; return { status: 200 }; },
    });
    assert.equal(result.ok, true, result.diagnostics.join('; '));
    // The actual function return and the generated response are the fixed local
    // business value, independent of the polluted template.
    assert.deepEqual(result.executions[0].output, { output: 'native-tool-result\n', exitCode: 0 });
    assert.deepEqual(sent.body.contents[2].parts[0].functionResponse.response, { output: 'native-tool-result\n', exitCode: 0 });
    assert.deepEqual(sent.body, cleanOracle);
    assert.notDeepEqual(sent.body, pollutedOracle);
  }
});

test('plain echo keeps the exact string under template pollution and maps to {output: actualString}', async () => {
  const fixture = loadFixture('gemini-native-declaration-schema-relay-json');
  const cleanOracle = loadFixture('gemini-native-declaration-schema-relay-json').turns[1].expected_provider_exact;
  Object.assign(fixture.turns[1].client_request.body.contents[2].parts[0].functionResponse.response, { output: 'decoy\n', exitCode: 0, extra: 'leak' });
  let sent;
  const result = await runToolFollowup({
    fixture,
    firstResult: jsonObserved(fixture.upstream_response.body),
    sendTurn: async (request) => { sent = request; return { status: 200 }; },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.equal(result.executions[0].output, 'native-tool-result');
  assert.deepEqual(sent.body.contents[2].parts[0].functionResponse.response, { output: 'native-tool-result' });
  assert.deepEqual(sent.body, cleanOracle);
});

test('a mutated expected_output fails the contract without rewriting the actual receipt or falling back', async () => {
  const fixture = loadFixture('gemini-native-root-fidelity-relay-json');
  fixture.tool_followup.expected_output = { output: 'wrong\n', exitCode: 0 };
  const result = await runToolFollowup({
    fixture,
    firstResult: jsonObserved(fixture.upstream_response.body),
    sendTurn: () => assert.fail('a mismatched expectation must not send'),
  });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('; '), /tool result mismatch/u);
  assert.deepEqual(result.executions[0].output, { output: 'native-tool-result\n', exitCode: 0 });
  assert.equal(result.turnResults.length, 1);
});

test('the observed argument drives the actual result, so a stale expectation fails and an aligned one passes', async () => {
  const stale = loadFixture('gemini-native-root-fidelity-relay-json');
  const observed = structuredClone(stale.upstream_response.body);
  observed.candidates[0].content.parts[0].functionCall.args.message = 'changed';
  const staleResult = await runToolFollowup({
    fixture: stale,
    firstResult: jsonObserved(observed),
    sendTurn: () => assert.fail('stale expectation must not send'),
  });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.diagnostics.join('; '), /tool result mismatch/u);
  assert.deepEqual(staleResult.executions[0].output, { output: 'changed\n', exitCode: 0 });

  const aligned = loadFixture('gemini-native-root-fidelity-relay-json');
  aligned.tool_followup.expected_output = { output: 'changed\n', exitCode: 0 };
  let sent;
  const alignedResult = await runToolFollowup({
    fixture: aligned,
    firstResult: jsonObserved(observed),
    sendTurn: async (request) => { sent = request; return { status: 200 }; },
  });
  assert.equal(alignedResult.ok, true, alignedResult.diagnostics.join('; '));
  assert.deepEqual(sent.body.contents[2].parts[0].functionResponse.response, { output: 'changed\n', exitCode: 0 });
});

test('unknown-tool correction denies the undeclared call, executes the declared echo once and follows up with the observed identity', async () => {
  const fixture = loadFixture('gemini-unknown-tool-correction-json');
  const sent = [];
  const result = await runToolFollowup({
    fixture,
    firstResult: jsonObserved(fixture.upstream_response.body),
    sendTurn: async (request, turnIndex) => {
      sent.push({ turnIndex, request });
      return jsonObserved(fixture.turns[turnIndex].upstream_response.body);
    },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.deepEqual(sent.map((entry) => entry.turnIndex), [1, 2]);
  assert.deepEqual(result.executions.map((entry) => [entry.id, entry.name, entry.output]), [['call_corrected_1', 'echo', 'corrected']]);
  assert.equal(result.executions.some((entry) => entry.name === 'outside_declared'), false);
  assert.deepEqual(sent[0].request.body.contents, fixture.turns[1].expected_provider_exact.contents);
  assert.deepEqual(sent[1].request.body.contents, fixture.turns[2].expected_provider_exact.contents);
  const errorResponse = sent[0].request.body.contents[2].parts[0].functionResponse;
  assert.equal(errorResponse.id, 'call_unknown_1');
  assert.equal(errorResponse.name, 'outside_declared');
  assert.deepEqual(errorResponse.response, { error: { code: 'unknown_tool', message: 'unknown tool outside_declared' } });
  assert.deepEqual(sent[0].request.body.contents[1].parts, fixture.upstream_response.body.candidates[0].content.parts);
});

test('unknown-tool correction merges streamed gemini parts and preserves the observed signature', async () => {
  const fixture = loadFixture('gemini-unknown-tool-correction-sse');
  const firstResult = { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyText: sseFromFixture(fixture.upstream_response.sse_events) };
  assert.deepEqual(extractToolCalls('gemini', firstResult), [
    { id: 'call_unknown_1', name: 'outside_declared', type: 'functionCall', arguments: { text: 'must-not-execute' } },
  ]);
  const sent = [];
  const result = await runToolFollowup({
    fixture,
    firstResult,
    sendTurn: async (request, turnIndex) => {
      sent.push({ turnIndex, request });
      return jsonObserved(fixture.turns[turnIndex].upstream_response.body);
    },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.deepEqual(result.executions.map((entry) => [entry.id, entry.name, entry.output]), [['call_corrected_1', 'echo', 'corrected']]);
  assert.deepEqual(sent[0].request.body.contents[1].parts, fixture.turns[1].expected_provider_exact.contents[1].parts);
});

test('gemini echo consumer accepts a missing native id but still rejects a missing declared argument key', () => {
  const fixture = loadFixture('gemini-native-root-fidelity-relay-json');
  const request = fixture.client_request;
  assert.equal(executeDeclaredEchoTool({ request, call: { id: '', name: 'echo', type: 'functionCall', arguments: { message: 'ok' } } }), 'ok');
  assert.throws(
    () => executeDeclaredEchoTool({ request, call: { id: '', name: 'echo', type: 'functionCall', arguments: { text: 'wrong-key' } } }),
    /exactly one message string argument/u,
  );
});

test('local namespace mock records the observed call to one exclusive file and submits the readback output', async () => {
  const fixture = loadFixture('namespace-local-client-mock-execution');
  const created = [];
  const effectBytes = JSON.stringify({ call_id: 'call_ns_1', namespace: 'collaboration', name: 'spawn_agent', arguments: { message: 'do work' } });
  let sent;
  const result = await runToolFollowup({
    fixture,
    firstResult: namespaceFirstCall,
    effectPath: '/owned-tmp/namespace-local-mock/effect.json',
    effect: {
      create: (path, contents) => { created.push({ path, contents }); return path; },
      read: () => effectBytes,
    },
    sendTurn: async (request) => { sent = request; return { status: 200 }; },
  });
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.deepEqual(created, [{ path: '/owned-tmp/namespace-local-mock/effect.json', contents: effectBytes }]);
  assert.equal(result.localInvocation.output, 'local namespace mock recorded: do work');
  assert.deepEqual(sent.body.input.slice(-2), [
    { type: 'function_call', call_id: 'call_ns_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"do work"}' },
    { type: 'function_call_output', call_id: 'call_ns_1', output: 'local namespace mock recorded: do work' },
  ]);
});

test('local namespace mock rejects undeclared, unbound or malformed calls before any effect', async () => {
  const fixture = loadFixture('namespace-local-client-mock-execution');
  const cases = [
    { name: 'spawn_agent', namespace: 'other', arguments: '{"message":"do work"}' },
    { name: 'collaboration__spawn_agent', arguments: '{"message":"do work"}' },
    { name: 'exec_command', arguments: '{"message":"do work"}' },
    { name: 'spawn_agent', namespace: 'collaboration', arguments: '{"other":"x"}' },
    { name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"do work","extra":1}' },
    { name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"do' },
  ];
  for (const call of cases) {
    let created = 0;
    const result = await runToolFollowup({
      fixture,
      firstResult: { body: { output: [{ type: 'function_call', call_id: 'call_ns_1', ...call }] } },
      effectPath: '/owned-tmp/namespace-local-mock/effect.json',
      effect: { create: () => { created += 1; }, read: () => assert.fail('readback must not run') },
      sendTurn: () => assert.fail('rejected call must not send'),
    });
    assert.equal(result.ok, false, `${JSON.stringify(call)} must be rejected`);
    assert.equal(result.executions.length, 0);
    assert.equal(created, 0);
    assert.equal(result.turnResults.length, 1);
  }
});

test('local namespace mock needs a runner-owned effect path and a function call', () => {
  const fixture = loadFixture('namespace-local-client-mock-execution');
  const call = { id: 'call_ns_1', namespace: 'collaboration', name: 'spawn_agent', type: 'function_call', arguments: '{"message":"do work"}' };
  assert.throws(() => executeLocalNamespaceMock({ fixture, request: fixture.client_request, call, effectPath: '   ' }), /runner-owned effect path required/u);
  assert.throws(() => executeLocalNamespaceMock({ fixture, request: fixture.client_request, call: { ...call, type: 'custom_tool_call' }, effectPath: '/owned-tmp/effect.json' }), /declared tool type mismatch/u);
  assert.throws(() => executeLocalNamespaceMock({ fixture: { ...fixture, tool_followup: { ...fixture.tool_followup, consumer: 'echo' } }, request: fixture.client_request, call, effectPath: '/owned-tmp/effect.json' }), /not declared as a local namespace mock consumer/u);
});

test('local namespace mock exclusive write keeps the first record and reports an occupied path', async () => {
  const fixture = loadFixture('namespace-local-client-mock-execution');
  const dir = mkdtempSync(join(tmpdir(), 'namespace-local-mock-'));
  const effectPath = join(dir, 'effect.json');
  writeFileSync(effectPath, 'occupied');
  try {
    const result = await runToolFollowup({
      fixture,
      firstResult: namespaceFirstCall,
      effectPath,
      sendTurn: () => assert.fail('occupied path must not send'),
    });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics.join('; '), /EEXIST/u);
    assert.equal(readFileSync(effectPath, 'utf8'), 'occupied');
    assert.equal(existsSync(join(dir, 'effect.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
