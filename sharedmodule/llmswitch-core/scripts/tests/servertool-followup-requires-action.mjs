#!/usr/bin/env node
/**
 * Regression: valid servertool reenter followups must accept Responses tool-call payloads
 * (status:"requires_action") without treating them as empty.
 *
 * We trigger an explicit `clock` servertool tool_call, which performs one internal
 * reenter hop. The reenter response is `status:"requires_action"` and must be preserved.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');

  const sessionId = `servertool-requires-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = `req_${Date.now()}`;

  const adapterContext = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    providerKey: 'antigravity.test.clock_requires_action',
    sessionId,
    capturedChatRequest: {
      model: 'gpt-5.2-codex',
      messages: [{ role: 'user', content: '请帮我设置一个提醒，然后继续执行' }],
      tools: []
    }
  };

  const chat = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_clock_test',
              type: 'function',
              function: {
                name: 'clock',
                arguments: JSON.stringify({
                  action: 'get'
                })
              }
            }
          ]
        }
      }
    ]
  };

  const patch = ['*** Begin Patch', '*** Add File: x.txt', '+x', '*** End Patch'].join('\n');
  const followupResponsesPayload = {
    id: `resp_${requestId}:stop_followup`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.2-codex',
    status: 'requires_action',
    output: [
      {
        id: 'function_call_test',
        type: 'function_call',
        status: 'in_progress',
        name: 'apply_patch',
        call_id: 'fc_test',
        arguments: JSON.stringify({ patch, input: patch })
      }
    ],
    required_action: {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [
          {
            id: 'fc_test',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ patch, input: patch })
            }
          }
        ]
      }
    }
  };

  let followupArgs = null;
  let reenterCalled = false;
  let reenterArgs = null;
  const res = await runServerToolOrchestration({
    chat,
    adapterContext,
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    clientInjectDispatch: async (args) => {
      followupArgs = args;
      return { ok: true };
    },
    reenterPipeline: async (args) => {
      reenterCalled = true;
      reenterArgs = args;
      return { body: followupResponsesPayload };
    }
  });

  assert.equal(res.executed, true, 'expected servertool executed');
  assert.equal(res.flowId, 'clock_flow', 'expected clock_flow');
  assert.ok(res.chat && typeof res.chat === 'object', 'expected chat payload');
  assert.equal(
    (res.chat).status,
    'requires_action',
    'reenter followup should preserve requires_action payload'
  );
  assert.equal(reenterCalled, true, 'clock_flow should reenter when captured request exists');
  assert.equal(followupArgs, null, 'reenter followup should not use clientInject dispatch');
  assert.ok(reenterArgs && typeof reenterArgs === 'object', 'expected reenter args');
  const metadata = reenterArgs.metadata && typeof reenterArgs.metadata === 'object' ? reenterArgs.metadata : {};
  assert.equal(metadata.clientInjectOnly, undefined, 'reenter flow should not require clientInjectOnly');
  const followupBody = reenterArgs.body && typeof reenterArgs.body === 'object' ? reenterArgs.body : {};
  const followupMessages = Array.isArray(followupBody.messages) ? followupBody.messages : [];
  const toolMessages = followupMessages.filter((item) => item && item.role === 'tool');
  assert.ok(toolMessages.length >= 1, 'clock_flow followup should append tool outputs before reenter');

  console.log('✅ servertool followup requires_action regression passed');
}

main().catch((err) => {
  console.error('❌ servertool followup requires_action regression failed:', err);
  process.exit(1);
});
