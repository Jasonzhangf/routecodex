#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildAnthropicResponseFromChat } from '../../dist/conversion/hub/response/response-runtime.js';

const chatPayload = {
  id: 'chatcmpl_usage_full_preserve',
  object: 'chat.completion',
  created: 1,
  model: 'doubao-seed-2.0-code',
  usage: {
    input_tokens: 48,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 }
  },
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'ok'
      }
    }
  ]
};

const mapped = buildAnthropicResponseFromChat(chatPayload, { model: 'doubao-seed-2.0-code' });
assert.equal(mapped?.usage?.input_tokens, 48);
assert.equal(mapped?.usage?.output_tokens, 1);
assert.equal(mapped?.usage?.cache_read_input_tokens, 0);
assert.deepEqual(mapped?.usage?.input_tokens_details, { cached_tokens: 0 });
console.log('[anthropic-usage-full-preserve] ok');
