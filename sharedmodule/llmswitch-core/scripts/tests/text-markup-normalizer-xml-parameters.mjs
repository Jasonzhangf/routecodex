#!/usr/bin/env node
/**
 * Regression: Anthropic/GLM sometimes emits tool calls as XML with <parameter name="...">.
 * These must be lifted into tool_calls; otherwise servertool orchestration cannot run.
 *
 * Example seen in codex-samples (RouteCodex):
 *   ~/.routecodex/codex-samples/openai-responses/tabglm.key1.glm-4.7/req_1768806413820_a2b15189/
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'text-markup-normalizer.js'));

const { normalizeAssistantTextToToolCalls } = mod;

const content = `<exec_command>
<parameter name="command">["cd", "/Users/fanzhang/Documents/github/webauto/modules/xiaohongshu/app", "&&", "npm", "run", "build"]</parameter>
<parameter name="workdir">/Users/fanzhang/Documents/github/webauto</parameter>
</exec_command>`;

const msg = { role: 'assistant', content };
const normalized = normalizeAssistantTextToToolCalls({ ...msg });

assert.ok(normalized && typeof normalized === 'object', 'normalized message must be an object');
assert.equal(normalized.role, 'assistant');
assert.equal(normalized.content, '', 'content must be cleared after lifting tool_calls');
assert.ok(Array.isArray(normalized.tool_calls), 'tool_calls must be an array');
assert.equal(normalized.tool_calls.length, 1, 'expected exactly 1 tool call');

const tc = normalized.tool_calls[0];
assert.equal(tc.type, 'function');
assert.equal(tc.function?.name, 'exec_command');

const args = JSON.parse(tc.function?.arguments || '{}');
assert.equal(args.workdir, '/Users/fanzhang/Documents/github/webauto');
assert.equal(
  args.cmd,
  'cd /Users/fanzhang/Documents/github/webauto/modules/xiaohongshu/app && npm run build',
  'cmd must be a shell string (not a JSON array literal)'
);
assert.ok(typeof args.cmd === 'string' && !args.cmd.trim().startsWith('['), 'cmd must not be an array literal');

// Variant: mismatched closing tag + thinking wrapper (seen in RouteCodex samples)
const content2 = `[思考]\n[/思考]<exec_command>\n<parameter name="command">[\"node\", \"scripts/xiaohongshu/phase1-start.mjs\", \"--headless=0\"]</parameter>\n<parameter name="workdir">/Users/fanzhang/Documents/github/webauto</parameter>\n</func_call>\n[/思考]`;

const normalized2 = normalizeAssistantTextToToolCalls({ role: 'assistant', content: content2 });
assert.ok(Array.isArray(normalized2.tool_calls), 'tool_calls must be an array for mismatched closing tag case');
assert.equal(normalized2.tool_calls.length, 1, 'expected exactly 1 tool call for mismatched closing tag case');
assert.equal(normalized2.tool_calls[0].function?.name, 'exec_command');
const args2 = JSON.parse(normalized2.tool_calls[0].function?.arguments || '{}');
assert.equal(args2.workdir, '/Users/fanzhang/Documents/github/webauto');
assert.equal(args2.cmd, 'node scripts/xiaohongshu/phase1-start.mjs --headless=0');

console.log('✅ text-markup-normalizer XML <parameter> tool call uplift passed');
