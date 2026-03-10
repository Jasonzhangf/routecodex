#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAnthropicConverters } from '../../dist/sse/index.js';

function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function main() {
  const streamText = [
    toSse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_seed_usage',
        type: 'message',
        role: 'assistant',
        model: 'doubao-seed-2.0-code',
        content: [],
        usage: { input_tokens: 34794, output_tokens: 12, cache_read_input_tokens: 0 }
      }
    }),
    toSse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'exec_command', input: {} }
    }),
    toSse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":"pwd"}' }
    }),
    toSse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    toSse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 63 }
    }),
    toSse('message_stop', { type: 'message_stop' })
  ].join('');

  const anthropic = createAnthropicConverters();
  const result = await anthropic.sseToJson.convertSseToJson(Readable.from([streamText]), {
    requestId: 'anthropic-seed-usage-merge'
  });

  assert.equal(result?.usage?.input_tokens, 34794);
  assert.equal(result?.usage?.output_tokens, 63);
  assert.equal(result?.usage?.cache_read_input_tokens, 0);
  console.log('[anthropic-sse-usage-merge] ok');
}

main().catch((error) => {
  console.error('[anthropic-sse-usage-merge] failed', error);
  process.exit(1);
});
