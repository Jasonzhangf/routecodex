#!/usr/bin/env node
/**
 * Regression: some models emit broken tool markup and leave a bare shell command
 * in the assistant text (e.g. "rg ... </arg_value></tool_call>").
 *
 * In tool-mode, we salvage the command into an exec_command tool_call so that
 * servertool orchestration can continue.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Make workdir deterministic for this test.
try {
  process.env.ROUTECODEX_WORKDIR = '';
  process.env.RCC_WORKDIR = '';
  process.env.CLAUDE_WORKDIR = '';
  delete process.env.PWD;
} catch {
  /* ignore */
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'text-markup-normalizer.js'));

const { normalizeAssistantTextToToolCalls } = mod;

// Case A: broken tool_call tail leaves a plain command line.
const contentA = `现在需要确认 container-library/xiaohongshu/home.md 中是否定义了 search_input 容器。\n\nrg \"search_input\" container-library/xiaohongshu/ -A 5</arg_value></tool_call>`;
const normalizedA = normalizeAssistantTextToToolCalls({ role: 'assistant', content: contentA });
assert.ok(Array.isArray(normalizedA.tool_calls), 'tool_calls must be extracted from bare rg command');
assert.equal(normalizedA.tool_calls.length, 1, 'expected exactly 1 tool call from bare rg command');
assert.equal(normalizedA.tool_calls[0].function?.name, 'exec_command');
const argsA = JSON.parse(normalizedA.tool_calls[0].function?.arguments || '{}');
assert.equal(argsA.cmd, 'rg \"search_input\" container-library/xiaohongshu/ -A 5');
assert.ok(!('workdir' in argsA), 'workdir must not be forced when env workdir is absent');

// Case B: "Ran [..]" JSON-array command description.
const contentB = `• Ran [\"ls\", \"-l\", \"dist/modules/xiaohongshu/app/blocks/Phase2SearchBlock.js\"]`;
const normalizedB = normalizeAssistantTextToToolCalls({ role: 'assistant', content: contentB });
assert.ok(Array.isArray(normalizedB.tool_calls), 'tool_calls must be extracted from Ran [..] array');
assert.equal(normalizedB.tool_calls.length, 1, 'expected exactly 1 tool call from Ran [..] array');
assert.equal(normalizedB.tool_calls[0].function?.name, 'exec_command');
const argsB = JSON.parse(normalizedB.tool_calls[0].function?.arguments || '{}');
assert.equal(argsB.cmd, 'ls -l dist/modules/xiaohongshu/app/blocks/Phase2SearchBlock.js');

console.log('✅ text-markup-normalizer bare command salvage passed');

