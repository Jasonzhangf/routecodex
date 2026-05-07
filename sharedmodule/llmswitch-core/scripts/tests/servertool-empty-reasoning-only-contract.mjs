#!/usr/bin/env node
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

  const sessionId = `servertool-empty-reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = `req_${Date.now()}`;

  const adapterContext = {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat',
    providerKey: 'antigravity.test.empty_reasoning',
    sessionId,
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
        message: { role: 'assistant', content: '', reasoning: '我将继续完成当前任务。' }
      }
    ]
  };

  let followupArgs = null;
  let reenterCalled = false;
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
    reenterPipeline: async () => {
      reenterCalled = true;
      return { body: { unexpected: true } };
    }
  });

  assert.equal(res.executed, false, 'empty assistant payload must not trigger servertool');
  assert.equal(res.flowId, undefined, 'invalid payload should not produce a flow id');
  assert.equal(reenterCalled, false, 'invalid payload must not reenter');
  assert.equal(followupArgs, null, 'invalid payload must not use clientInject dispatch');
  assert.ok(res.chat && typeof res.chat === 'object', 'expected original chat payload');
  assert.equal(res.chat.object, 'chat.completion', 'original payload should pass through unchanged');

  console.log('✅ servertool empty reasoning-only payload regression passed');
}

main().catch((err) => {
  console.error('❌ servertool empty reasoning-only payload regression failed:', err);
  process.exit(1);
});
