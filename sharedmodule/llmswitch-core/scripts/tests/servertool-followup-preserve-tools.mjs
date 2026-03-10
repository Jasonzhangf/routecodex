#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { buildServerToolFollowupChatPayloadFromInjection } = await import(
    path.resolve(repoRoot, 'dist/servertool/handlers/followup-request-builder.js')
  );

  const capturedChatRequest = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Run a shell command',
          parameters: { type: 'object', additionalProperties: true }
        }
      }
    ],
    parameters: { tool_choice: 'auto', parallel_tool_calls: true }
  };

  const adapterContext = { capturedChatRequest };
  const chatResponse = {
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  };

  const defaultTools = buildServerToolFollowupChatPayloadFromInjection({
    adapterContext,
    chatResponse,
    injection: { ops: [{ op: 'append_user_text', text: 'continue' }] }
  });
  assert.ok(defaultTools, 'followup payload should be built');
  assert.ok(
    Array.isArray(defaultTools.tools) && defaultTools.tools.length === 1,
    'tools must be preserved by default (standard request cleaning)'
  );
  assert.equal(defaultTools.tools[0]?.function?.name, 'exec_command');
  assert.equal(defaultTools.parameters?.tool_choice, undefined);
  assert.equal(defaultTools.parameters?.parallel_tool_calls, true);

  const keepTools = buildServerToolFollowupChatPayloadFromInjection({
    adapterContext,
    chatResponse,
    injection: { ops: [{ op: 'preserve_tools' }, { op: 'append_user_text', text: 'continue' }] }
  });
  assert.ok(keepTools, 'followup payload should be built');
  assert.ok(Array.isArray(keepTools.tools) && keepTools.tools.length === 1, 'tools must be preserved');
  assert.equal(keepTools.tools[0]?.function?.name, 'exec_command');

  const dropped = buildServerToolFollowupChatPayloadFromInjection({
    adapterContext,
    chatResponse,
    injection: { ops: [{ op: 'drop_tool_by_name', name: 'exec_command' }, { op: 'append_user_text', text: 'continue' }] }
  });
  assert.ok(dropped, 'followup payload should be built');
  assert.ok(Array.isArray(dropped.tools) && dropped.tools.length === 0, 'drop_tool_by_name must remove tool');

  console.log('[servertool-followup-preserve-tools] tests passed');
}

main().catch((e) => {
  console.error('❌ [servertool-followup-preserve-tools] failed', e);
  process.exit(1);
});
