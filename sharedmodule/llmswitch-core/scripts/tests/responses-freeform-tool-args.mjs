#!/usr/bin/env node
/**
 * Regression: when the client declares a tool with format:"freeform",
 * the outbound Responses payload must emit raw text in `arguments` (not a JSON wrapper).
 *
 * This matters for Codex CLI style tools such as apply_patch.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadBridge() {
  return import(pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')).href);
}

function makeChatCompletionWithApplyPatchToolCall() {
  const patch = ['*** Begin Patch', '*** Add File: hello.txt', '+hello', '*** End Patch'].join('\n');
  return {
    id: 'chatcmpl_freeform',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch, input: patch })
              }
            }
          ]
        }
      }
    ]
  };
}

async function main() {
  const { buildResponsesPayloadFromChat } = await loadBridge();
  const chat = makeChatCompletionWithApplyPatchToolCall();

  const toolsRaw = [
    {
      type: 'function',
      name: 'apply_patch',
      description: 'freeform apply_patch',
      format: 'freeform'
    }
  ];

  const out = buildResponsesPayloadFromChat(chat, { requestId: 'req_freeform', toolsRaw });
  assert.equal(out.status, 'requires_action', 'expected requires_action');

  const outputItem = Array.isArray(out.output) ? out.output.find((x) => x && x.type === 'function_call') : null;
  assert.ok(outputItem, 'expected output function_call item');
  assert.equal(outputItem.status, 'in_progress', 'expected function_call status=in_progress when requires_action');
  assert.equal(outputItem.name, 'apply_patch', 'expected apply_patch function_call');

  // For format:"freeform", arguments should be patch text (not JSON wrapper).
  assert.ok(typeof outputItem.arguments === 'string', 'expected arguments to be a string');
  assert.ok(outputItem.arguments.trim().startsWith('*** Begin Patch'), 'expected freeform patch text in output.arguments');
  assert.ok(!outputItem.arguments.trim().startsWith('{'), 'expected output.arguments NOT to be JSON');

  const ra = out.required_action?.submit_tool_outputs?.tool_calls;
  assert.ok(Array.isArray(ra) && ra.length > 0, 'expected required_action tool_calls');
  const ra0 = ra[0];
  assert.equal(ra0.function?.name, 'apply_patch', 'expected required_action apply_patch');
  assert.ok(typeof ra0.function?.arguments === 'string', 'expected required_action.arguments string');
  assert.ok(
    ra0.function.arguments.trim().startsWith('*** Begin Patch'),
    'expected freeform patch text in required_action.arguments'
  );

  console.log('✅ responses freeform tool args regression passed');
}

main().catch((err) => {
  console.error('❌ responses freeform tool args regression failed:', err);
  process.exit(1);
});
