#!/usr/bin/env node
/**
 * Regression: response tool text canonicalizer must uplift <tool:exec_command> markup into tool_calls.
 *
 * This validates the full response filter pipeline path (not just the text-markup-normalizer helper).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'tool-filter-pipeline.js'));

const { runChatResponseToolFilters } = mod;

const content = `<tool:exec_command>
<command>which flutter</command>
<timeout_ms>10000</timeout_ms>
</tool:exec_command>

<tool:exec_command>
<command>flutter --version</command>
<timeout_ms>30000</timeout_ms>
<requires_approval>false</requires_approval>
</tool:exec_command>`;

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
  requestId: 'req_test_response_tool_text_tool_namespace',
  profile: 'openai-chat'
});

const choice = out?.choices?.[0];
assert.ok(choice && typeof choice === 'object', 'choice must exist');
assert.equal(choice.finish_reason, 'tool_calls', 'finish_reason must be tool_calls after uplifting');

const msg = choice.message;
assert.ok(msg && typeof msg === 'object', 'message must exist');
assert.equal(msg.role, 'assistant');
assert.ok(msg.content === '' || msg.content === null, 'content must be cleared after uplifting');
assert.ok(Array.isArray(msg.tool_calls), 'tool_calls must be present');
assert.equal(msg.tool_calls.length, 2, 'expected exactly 2 tool calls');

const tc1 = msg.tool_calls[0];
assert.equal(tc1.type, 'function');
assert.equal(tc1.function?.name, 'exec_command');
const a1 = JSON.parse(tc1.function?.arguments || '{}');
assert.equal(a1.cmd, 'which flutter');
assert.equal(a1.timeout_ms, 10000);

const tc2 = msg.tool_calls[1];
assert.equal(tc2.type, 'function');
assert.equal(tc2.function?.name, 'exec_command');
const a2 = JSON.parse(tc2.function?.arguments || '{}');
assert.equal(a2.cmd, 'flutter --version');
assert.equal(a2.timeout_ms, 30000);

console.log('✅ response tool text canonicalize <tool:*> uplift passed');

