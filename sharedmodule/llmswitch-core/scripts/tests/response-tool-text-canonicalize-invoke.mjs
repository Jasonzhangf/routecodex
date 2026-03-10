#!/usr/bin/env node
/**
 * Regression: response tool text canonicalizer must uplift <function_calls><invoke> into tool_calls.
 *
 * This validates the full response filter pipeline path (not just the text-markup-normalizer helper).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'tool-filter-pipeline.js'));

const { runChatResponseToolFilters } = mod;

const content = `<function_calls>
<invoke name="write_stdin">
<parameter name="session_id">91806</parameter>
<parameter name="data"></parameter>
<parameter name="wait">10</parameter>
</invoke>
</function_calls>`;

const chat = {
  id: 'chatcmpl_test',
  object: 'chat.completion',
  model: 'unknown',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content }
    }
  ]
};

const out = await runChatResponseToolFilters(chat, {
  entryEndpoint: '/v1/responses',
  requestId: 'req_test_response_tool_text_invoke',
  profile: 'openai-chat'
});

const msg = out?.choices?.[0]?.message;
assert.ok(msg && typeof msg === 'object', 'message must exist');
assert.equal(msg.role, 'assistant');
assert.ok(msg.content === '' || msg.content === null, 'content must be cleared after uplifting');
assert.ok(Array.isArray(msg.tool_calls), 'tool_calls must be present');
assert.equal(msg.tool_calls.length, 1, 'expected exactly 1 tool call');

const tc = msg.tool_calls[0];
assert.equal(tc.type, 'function');
assert.equal(tc.function?.name, 'write_stdin');
const args = JSON.parse(tc.function?.arguments || '{}');
assert.equal(args.session_id, 91806);
assert.equal(args.chars, '');
assert.equal(args.yield_time_ms, 10_000);

console.log('✅ response tool text canonicalize <invoke> uplift passed');
