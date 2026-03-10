#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createAnthropicConverters } from '../../dist/sse/index.js';

function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* terminatedAnthropicSseStream() {
  yield toSse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_terminated_salvage',
      type: 'message',
      role: 'assistant',
      model: 'kimi-k2.5',
      content: [],
      usage: { input_tokens: 123, output_tokens: 1, cache_read_input_tokens: 0 }
    }
  });
  yield toSse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' }
  });
  yield toSse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: '先检查差异' }
  });
  yield toSse('content_block_stop', { type: 'content_block_stop', index: 0 });
  yield toSse('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'tool_1', name: 'exec_command', input: {} }
  });
  yield toSse('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"cmd":"pwd"' }
  });
  throw new Error('terminated');
}

async function main() {
  const anthropic = createAnthropicConverters();
  const result = await anthropic.sseToJson.convertSseToJson(terminatedAnthropicSseStream(), {
    requestId: 'anthropic-terminated-salvage'
  });

  assert.equal(result.id, 'msg_terminated_salvage');
  assert.equal(result.model, 'kimi-k2.5');
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.usage?.input_tokens, 123);
  assert.equal(result.usage?.output_tokens, 1);
  assert.equal(Array.isArray(result.content), true);
  const toolUse = result.content.find((block) => block?.type === 'tool_use');
  assert.ok(toolUse, 'expected salvaged tool_use block');
  assert.equal(toolUse?.name, 'exec_command');
  assert.deepEqual(toolUse?.input, { _raw: '{\"cmd\":\"pwd\"' });
  console.log('[anthropic-sse-to-json-terminated-salvage] ok');
}

main().catch((error) => {
  console.error('[anthropic-sse-to-json-terminated-salvage] failed', error);
  process.exit(1);
});
