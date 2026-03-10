#!/usr/bin/env node
/**
 * Regression: some Gemini/Antigravity outputs emit tool calls as:
 *   <function_calls>
 *     <invoke name="write_stdin">
 *       <parameter name="session_id">91806</parameter>
 *       <parameter name="data"></parameter>
 *       <parameter name="wait">10</parameter>
 *     </invoke>
 *   </function_calls>
 *
 * These must be lifted into tool_calls; otherwise servertool orchestration cannot run.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'text-markup-normalizer.js'));

const { normalizeAssistantTextToToolCalls } = mod;

const content = `• <function_calls>
  <invoke name="write_stdin">
  <parameter name="session_id">91806</parameter>
  <parameter name="data"></parameter>
  <parameter name="wait">10</parameter>
  </invoke>
  </function_calls>`;

const msg = { role: 'assistant', content };
const normalized = normalizeAssistantTextToToolCalls({ ...msg });

assert.ok(normalized && typeof normalized === 'object', 'normalized message must be an object');
assert.equal(normalized.role, 'assistant');
assert.equal(normalized.content, '', 'content must be cleared after lifting tool_calls');
assert.ok(Array.isArray(normalized.tool_calls), 'tool_calls must be an array');
assert.equal(normalized.tool_calls.length, 1, 'expected exactly 1 tool call');

const tc = normalized.tool_calls[0];
assert.equal(tc.type, 'function');
assert.equal(tc.function?.name, 'write_stdin');

const args = JSON.parse(tc.function?.arguments || '{}');
assert.equal(args.session_id, 91806);
assert.equal(args.chars, '');
assert.equal(args.yield_time_ms, 10_000);

console.log('✅ text-markup-normalizer <invoke> tool call uplift passed');

