#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAnthropicConverters } from '../../dist/sse/index.js';

function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const streamText = [
  toSse('message_start', {
    type: 'message_start',
    message: { id: 'msg_stop_seq', type: 'message', role: 'assistant', model: 'seed', content: [] }
  }),
  toSse('content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
  }),
  toSse('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' }
  }),
  toSse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  toSse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'stop_sequence', stop_sequence: '</done>' }
  }),
  toSse('message_stop', { type: 'message_stop' })
].join('');

const anthropic = createAnthropicConverters();
const result = await anthropic.sseToJson.convertSseToJson(Readable.from([streamText]), { requestId: 'anthropic-stop-seq' });
assert.equal(result?.stop_reason, 'stop_sequence');
assert.equal(result?.stop_sequence, '</done>');
console.log('[anthropic-sse-stop-sequence] ok');
