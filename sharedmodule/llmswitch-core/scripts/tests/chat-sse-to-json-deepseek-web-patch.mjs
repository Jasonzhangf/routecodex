#!/usr/bin/env node

import assert from 'node:assert/strict';

async function* deepseekWebPatchSse() {
  yield 'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n';
  yield 'data: {"v":{"response":{"message_id":2,"status":"WIP","content":""}}}\n\n';
  yield 'data: {"p":"response/content","o":"APPEND","v":"{\\""}\n\n';
  yield 'data: {"v":"tool"}\n\n';
  yield 'data: {"v":"_calls"}\n\n';
  yield 'data: {"v":"\\":["}\n\n';
  yield 'data: {"v":"{\\"name\\":\\"continue_execution\\",\\"input\\":{}}"}\n\n';
  yield 'data: {"v":"]}"}\n\n';
  yield 'data: {"p":"response/accumulated_token_usage","o":"SET","v":690}\n\n';
  yield 'data: {"p":"response/status","v":"FINISHED"}\n\n';
  yield 'event: finish\ndata: {}\n\n';
}

async function* deepseekWebPatchSseMultiLineDataFrame() {
  yield 'event: ready\ndata: {"request_message_id":11,"response_message_id":12}\n\n';
  yield 'data: {"v":{"response":{"message_id":12,"status":"WIP","content":""}}}\n\n';
  // Simulate one SSE frame that contains multiple data lines.
  yield 'data: {"p":"response/content","o":"APPEND","v":"x"}\ndata: {"v":"y"}\n\n';
  yield 'data: {"p":"response/status","v":"FINISHED"}\n\n';
  yield 'event: finish\ndata: {}\n\n';
}

function assertResult(result, expectedPattern) {
  assert.ok(Array.isArray(result.choices));
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.match(String(result.choices[0].message.content || ''), expectedPattern);
}

async function main() {
  const { ChatSseToJsonConverter } = await import('../../dist/sse/sse-to-json/chat-sse-to-json-converter.js');
  const converter = new ChatSseToJsonConverter();
  const result = await converter.convertSseToJson(deepseekWebPatchSse(), {
    requestId: 'chat-deepseek-web-patch',
    model: 'deepseek-chat'
  });
  assertResult(result, /\{"tool_calls":\[\{"name":"continue_execution","input":\{\}\}\]\}/);

  const multiLineResult = await converter.convertSseToJson(deepseekWebPatchSseMultiLineDataFrame(), {
    requestId: 'chat-deepseek-web-patch-multiline-data',
    model: 'deepseek-chat'
  });
  assertResult(multiLineResult, /xy/);

  console.log('✅ chat-sse-to-json-deepseek-web-patch passed');
}

main().catch((e) => {
  console.error('❌ chat-sse-to-json-deepseek-web-patch failed:', e);
  process.exit(1);
});
