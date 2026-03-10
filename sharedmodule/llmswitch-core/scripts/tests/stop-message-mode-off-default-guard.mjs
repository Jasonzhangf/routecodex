#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

function createStopChat(content = '阶段完成。') {
  return {
    id: 'chatcmpl_stop',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content }
      }
    ]
  };
}

function buildAdapterContext(args) {
  return {
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    providerKey: 'tab.key1.gpt-5.3-codex',
    sessionId: args.sessionId,
    __rt: args.runtimeState ? { stopMessageState: args.runtimeState } : {},
    capturedChatRequest: {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: '继续推进任务' }],
      tools: []
    }
  };
}

async function runStopRequest(runServerToolOrchestration, args) {
  return runServerToolOrchestration({
    chat: createStopChat(),
    adapterContext: buildAdapterContext(args),
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    reenterPipeline: async () => ({ body: createStopChat('ok') })
  });
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');
  const { saveRoutingInstructionStateSync } = await importModule('router/virtual-router/sticky-session-store.js');

  const originalHome = process.env.HOME;
  const originalUserDir = process.env.ROUTECODEX_USER_DIR;
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const originalDefaultEnabled = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
  const originalAutoIflow = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-message-mode-off-'));
  const userDir = path.join(tmpRoot, 'user');
  const sessionDir = path.join(userDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });

  process.env.HOME = tmpRoot;
  process.env.ROUTECODEX_USER_DIR = userDir;
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;
  process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '0';

  try {
    // Baseline: without marker/state stopMessage must not trigger.
    const baselineSessionId = `stop-default-baseline-${Date.now()}`;
    const baseline = await runStopRequest(runServerToolOrchestration, {
      sessionId: baselineSessionId,
      requestId: `${baselineSessionId}-1`
    });
    assert.equal(baseline.executed, false, 'stopMessage should not trigger without explicit marker/state');

    // Guard: explicit mode=off in runtime state must suppress default fallback.
    const runtimeOffSessionId = `stop-off-runtime-${Date.now()}`;
    const runtimeOff = await runStopRequest(runServerToolOrchestration, {
      sessionId: runtimeOffSessionId,
      requestId: `${runtimeOffSessionId}-1`,
      runtimeState: { stopMessageStageMode: 'off', stopMessageSource: 'explicit' }
    });
    assert.equal(runtimeOff.executed, false, 'explicit mode=off runtime state must disable stop_message_flow');

    // Guard: persisted sticky mode=off must also suppress default fallback.
    const stickyOffSessionId = `stop-off-sticky-${Date.now()}`;
    saveRoutingInstructionStateSync(`session:${stickyOffSessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageSource: 'explicit',
      stopMessageStageMode: 'off',
      stopMessageText: undefined,
      stopMessageMaxRepeats: undefined,
      stopMessageUsed: undefined,
      stopMessageUpdatedAt: Date.now(),
      stopMessageLastUsedAt: undefined
    });
    const stickyOff = await runStopRequest(runServerToolOrchestration, {
      sessionId: stickyOffSessionId,
      requestId: `${stickyOffSessionId}-1`
    });
    assert.equal(stickyOff.executed, false, 'explicit mode=off sticky state must disable stop_message_flow');

    console.log('✅ stop-message mode=off default-guard regression passed');
  } finally {
    if (typeof originalHome === 'string') process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (typeof originalUserDir === 'string') process.env.ROUTECODEX_USER_DIR = originalUserDir;
    else delete process.env.ROUTECODEX_USER_DIR;
    if (typeof originalSessionDir === 'string') process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    else delete process.env.ROUTECODEX_SESSION_DIR;
    if (typeof originalDefaultEnabled === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = originalDefaultEnabled;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    }
    if (typeof originalAutoIflow === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = originalAutoIflow;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    }
  }
}

main().catch((error) => {
  console.error('❌ stop-message mode=off default-guard regression failed:', error);
  process.exit(1);
});
