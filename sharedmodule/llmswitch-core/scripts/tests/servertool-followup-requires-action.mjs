#!/usr/bin/env node
/**
 * Regression: servertool auto-followups must not misclassify Responses tool-call payloads
 * (status:"requires_action") as "empty followup" and throw SERVERTOOL_EMPTY_FOLLOWUP.
 *
 * stop_message_flow can legitimately lead to a tool call; in that case we should return the
 * tool-call payload to the client and let the client handle execution/validation.
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
    providerProtocol: 'gemini-chat',
    providerKey: 'antigravity.test.requires_action',
    sessionId,
    clientTmuxSessionId: `tmux_${sessionId}`,
    tmuxSessionId: `tmux_${sessionId}`,
    __rt: {
      stopMessageState: {
        stopMessageText: '继续执行',
        stopMessageMaxRepeats: 1,
        stopMessageUsed: 0,
        stopMessageSource: 'explicit'
      }
    },
    capturedChatRequest: {
      model: 'gpt-5.2-codex',
      messages: [{ role: 'user', content: 'hi' }],
      tools: []
    }
  };

  const chat = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' }
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
    providerProtocol: 'gemini-chat',
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
  assert.equal(res.flowId, 'stop_message_flow', 'expected stop_message_flow');
  assert.ok(res.chat && typeof res.chat === 'object', 'expected chat payload');
  assert.equal(
    (res.chat).status,
    undefined,
    'stop_message should not passthrough reenter requires_action payload'
  );
  assert.equal(reenterCalled, true, 'stop_message_flow should reenter by default');
  assert.equal(followupArgs, null, 'stop_message_flow should skip clientInject dispatch by default');
  assert.ok(reenterArgs && typeof reenterArgs === 'object', 'expected reenter args');
  const metadata = reenterArgs.metadata && typeof reenterArgs.metadata === 'object' ? reenterArgs.metadata : {};
  assert.equal(metadata.clientInjectOnly, undefined, 'stop_message reenter flow should not require clientInjectOnly');
  const followupBody = reenterArgs.body && typeof reenterArgs.body === 'object' ? reenterArgs.body : {};
  const followupMessages = Array.isArray(followupBody.messages) ? followupBody.messages : [];
  const lastMessage = [...followupMessages].reverse().find((item) => item && typeof item.content === 'string');
  const followupText = lastMessage && typeof lastMessage.content === 'string' ? lastMessage.content : '';
  assert.ok(
    followupText.includes('继续执行'),
    'stop_message should provide reenter followup text'
  );

  console.log('✅ servertool followup requires_action regression passed');
}

main().catch((err) => {
  console.error('❌ servertool followup requires_action regression failed:', err);
  process.exit(1);
});
