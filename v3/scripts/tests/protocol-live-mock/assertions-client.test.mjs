import assert from 'node:assert/strict';
import test from 'node:test';

import { assertClientResult } from './assertions.mjs';
import { COMPLETE_RECEIPT } from './assertions-test-support.mjs';
import { findSemanticTerminal, parseClientBody } from './protocol-semantics.mjs';

test('declared opaque business records pass JSON and SSE without hiding controls', () => {
  const opaque = { routecodex_chat_extension: { chat_extension_opaque_record: [{
    record_id: 'opaque-1', protocol: 'anthropic', path: 'response.type', encoding: 'json',
    canonical_path: 'chat.routecodex_chat_extension.chat_extension_opaque_record[0].value',
    value: 'message', future_business_member: { keep: true },
  }] } };
  const expected = { status: 200, transport: 'complete' };
  assert.equal(assertClientResult({
    ...COMPLETE_RECEIPT, status: 200, headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify(opaque),
  }, { ...expected, body_must_not: ['routecodex_chat_extension'] }, 'openai_chat').ok, false);
  for (const sse of [false, true]) {
    const result = {
      ...COMPLETE_RECEIPT, status: 200,
      headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
      bodyText: sse ? `data: ${JSON.stringify(opaque)}\n\n` : JSON.stringify(opaque),
    };
    assert.equal(assertClientResult(result, expected, 'openai_chat', {
      parseClientBody, findSemanticTerminal,
    }).ok, true);
  }
  for (const mutate of [
    (body) => { body.routecodex_internal = true; },
    (body) => { body.routecodex_chat_extension.metadata_center = {}; },
    (body) => { body.routecodex_chat_extension.chat_extension_opaque_record[0].value = { routecodex_internal: true }; },
    (body) => { body.routecodex_chat_extension.chat_extension_opaque_record[0].canonical_path += '.routecodex_internal'; },
    (body) => { body.routecodex_chat_extension.response_sequence = { runtime_control: true }; },
  ]) {
    const body = structuredClone(opaque);
    mutate(body);
    const result = assertClientResult({
      ...COMPLETE_RECEIPT, status: 200, headers: { 'content-type': 'application/json' },
      body, bodyText: JSON.stringify(body),
    }, expected, 'openai_chat');
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((line) => line.includes('control marker')));
  }
});

test('wire control checks cannot be suppressed by supplied observations or frame-shaped business data', () => {
  const expected = { status: 200, transport: 'complete' };
  for (const bodyText of [
    '{"routecodex_internal":true}', '{"broken": routecodex_internal',
    'data: routecodex_internal\n\n', '"routecodex_internal"',
  ]) {
    for (const observation of [{ kind: 'sse', frames: [] }, { kind: 'json', body: {} }]) {
      const result = assertClientResult({
        ...COMPLETE_RECEIPT, status: 200, headers: { 'content-type': 'text/event-stream' },
        observation, bodyText,
      }, expected, 'openai_chat', { parseClientBody, findSemanticTerminal });
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((line) => line.includes('control marker')));
    }
  }
  const business = { event: 'message', data: {}, raw_data: 'routecodex_internal' };
  assert.equal(assertClientResult({
    ...COMPLETE_RECEIPT, status: 200, headers: { 'content-type': 'application/json' },
    body: business, bodyText: JSON.stringify(business),
  }, expected, 'openai_chat').ok, false);
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

test('a client timeout, abort or overrun never passes as a product socket close', () => {
  const expected = { transport: 'closed', status: null };
  for (const code of ['ETIMEDOUT', 'ABORT_ERR', 'RESPONSE_TOO_LARGE']) {
    for (const [label, result] of [
      ['error_detail.code', { status: null, headers: {}, body: null, bodyText: '', closed: true,
        error: `stopped: ${code}`, error_detail: { name: 'Error', message: `stopped: ${code}`, code } }],
      ['error_code', { status: null, headers: {}, body: null, bodyText: '', closed: true,
        error: `stopped: ${code}`, error_code: code }],
    ]) {
      const outcome = assertClientResult(result, expected, 'gemini');
      assert.equal(outcome.ok, false, `${code}/${label} must not pass a closed expectation`);
      assert.ok(
        outcome.diagnostics.some((line) => line.includes(`test client stopped: ${code}`)),
        `${code}/${label} must report the client stop`,
      );
    }
  }

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
