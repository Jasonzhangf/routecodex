#!/usr/bin/env node
/**
 * Regression: /v1/responses upstream may return completed + empty assistant output.
 * The deprecated empty_reply_continue servertool must stay disabled and must not
 * inject a followup request back into the pipeline.
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

function buildCapturedTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_stdin',
        description: 'Write to stdin',
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'number' },
            chars: { type: 'string' }
          },
          required: ['session_id'],
          additionalProperties: false
        }
      }
    }
  ];
}

function buildEmptyCompletedChat() {
  return {
    id: 'chatcmpl_empty_completed',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.3-codex',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: ''
        }
      }
    ]
  };
}

function buildFollowupRequiresAction(requestId) {
  return {
    id: `resp_${requestId}_followup`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.3-codex',
    status: 'requires_action',
    output: [
      {
        id: 'fc_resume_1',
        type: 'function_call',
        status: 'in_progress',
        name: 'exec_command',
        call_id: 'call_resume_1',
        arguments: JSON.stringify({ command: 'pwd' })
      }
    ],
    required_action: {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [
          {
            id: 'call_resume_1',
            tool_call_id: 'call_resume_1',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ command: 'pwd' })
            }
          }
        ]
      }
    }
  };
}

async function runCase({ providerProtocol, providerKey }) {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');

  const requestId = `req_${providerProtocol}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const sessionId = `sess_empty_continue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const adapterContext = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol,
    providerKey,
    sessionId,
    capturedChatRequest: {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: '请继续执行' }],
      tools: buildCapturedTools(),
      parameters: {
        tool_choice: 'auto',
        parallel_tool_calls: true
      }
    }
  };

  let capturedFollowupArgs = null;
  const reenterPipeline = async (args) => {
    capturedFollowupArgs = args;
    return { body: buildFollowupRequiresAction(requestId) };
  };

  const result = await runServerToolOrchestration({
    chat: buildEmptyCompletedChat(),
    adapterContext,
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol,
    reenterPipeline
  });

  assert.ok(result.chat && typeof result.chat === 'object', 'expected orchestration response body');
  assert.equal(result.executed, false, `expected no auto followup executed (${providerProtocol})`);
  assert.equal(result.flowId, undefined, `expected no flow id (${providerProtocol})`);
  assert.equal(capturedFollowupArgs, null, `expected no followup args (${providerProtocol})`);
  assert.equal(result.chat.object, 'chat.completion', 'expected original response body propagated');
}

async function main() {
  const cases = [
    { providerProtocol: 'openai-responses', providerKey: 'crs.key1.gpt-5.3-codex' },
    { providerProtocol: 'openai-chat', providerKey: 'iflow.2-173.kimi-k2.5' },
    { providerProtocol: 'anthropic-messages', providerKey: 'lmstudio.key1.qwen3-coder-next-mlx' },
    { providerProtocol: 'gemini-chat', providerKey: 'antigravity.test.gemini-3-pro-high' }
  ];

  for (const testCase of cases) {
    await runCase(testCase);
  }

  console.log('✅ servertool empty responses continue disabled regression passed');
}

main().catch((err) => {
  console.error('❌ servertool empty responses continue regression failed:', err);
  process.exit(1);
});
