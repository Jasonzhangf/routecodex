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

function createStopChat() {
  return {
    id: 'chatcmpl_stop',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '阶段完成。' }
      }
    ]
  };
}

function createAdapterContext(args) {
  const runtime = {
    stopMessageState: {
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 0,
      stopMessageSource: 'explicit',
      stopMessageStageMode: 'on'
    }
  };
  if (args.followup === true) {
    runtime.serverToolFollowup = true;
    runtime.serverToolLoopState = { flowId: 'stop_message_flow' };
  }
  return {
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    providerKey: 'tab.key1.gpt-5.3-codex',
    sessionId: args.sessionId,
    clientTmuxSessionId: `tmux_${args.sessionId}`,
    tmuxSessionId: `tmux_${args.sessionId}`,
    __rt: runtime,
    capturedChatRequest: {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: '继续执行任务' }],
      tools: []
    }
  };
}

async function runOnce({ runServerToolOrchestration, sessionId, requestId, followup }) {
  return runServerToolOrchestration({
    chat: createStopChat(),
    adapterContext: createAdapterContext({ sessionId, requestId, followup }),
    requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    clientInjectDispatch: async () => ({ ok: true }),
    reenterPipeline: async () => ({ body: createStopChat() })
  });
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');

  const sessionId = `stop-followup-no-recursion-${Date.now()}`;

  try {
    const first = await runOnce({
      runServerToolOrchestration,
      sessionId,
      requestId: `req-${Date.now()}-1`,
      followup: false
    });
    assert.equal(first.executed, true, 'first request should trigger stop_message_flow');
    assert.equal(first.flowId, 'stop_message_flow');

    const second = await runOnce({
      runServerToolOrchestration,
      sessionId,
      requestId: `req-${Date.now()}-2:stop_followup`,
      followup: true
    });
    assert.equal(second.executed, false, 'internal followup request must not re-enter stop_message_flow');

    const third = await runOnce({
      runServerToolOrchestration,
      sessionId,
      requestId: `req-${Date.now()}-3`,
      followup: false
    });
    assert.equal(third.executed, true, 'next client request should still be interceptable');
    assert.equal(third.flowId, 'stop_message_flow');

    console.log('✅ stop-message followup no-recursion regression passed');
  } finally {
    // no-op
  }
}

main().catch((error) => {
  console.error('❌ stop-message followup no-recursion regression failed:', error);
  process.exit(1);
});
