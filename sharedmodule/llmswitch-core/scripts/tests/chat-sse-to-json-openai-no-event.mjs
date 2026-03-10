#!/usr/bin/env node

import assert from 'node:assert/strict';

async function* openaiStyleChatSse() {
  yield 'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1694268190,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
  yield 'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1694268190,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n';
  yield 'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1694268190,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
  yield 'data: [DONE]\n\n';
}

async function main() {
  const { ChatSseToJsonConverter } = await import('../../dist/sse/sse-to-json/chat-sse-to-json-converter.js');
  const converter = new ChatSseToJsonConverter();
  const result = await converter.convertSseToJson(openaiStyleChatSse(), {
    requestId: 'chat-openai-no-event',
    model: 'gpt-test'
  });

  assert.equal(result.id, 'chatcmpl_1');
  assert.ok(Array.isArray(result.choices));
  assert.ok(result.choices.length >= 1);
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.match(String(result.choices[0].message.content || ''), /Hi/);

  console.log('✅ chat-sse-to-json-openai-no-event passed');
}

main().catch((e) => {
  console.error('❌ chat-sse-to-json-openai-no-event failed:', e);
  process.exit(1);
});

