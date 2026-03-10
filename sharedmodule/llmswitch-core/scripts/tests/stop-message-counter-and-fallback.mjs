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

function createAdapterContext(args) {
  const runtime = {};
  if (args.includeRuntimeState) {
    runtime.stopMessageState = {
      stopMessageText: args.stopMessageText,
      stopMessageMaxRepeats: args.stopMessageMaxRepeats,
      stopMessageUsed: 0,
      stopMessageSource: 'explicit',
      stopMessageStageMode: 'on',
      ...(args.stopMessageAiMode ? { stopMessageAiMode: args.stopMessageAiMode } : {})
    };
  }
  return {
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    providerKey: 'tab.key1.gpt-5.3-codex',
    sessionId: args.sessionId,
    clientTmuxSessionId: args.tmuxSessionId,
    tmuxSessionId: args.tmuxSessionId,
    __rt: runtime,
    capturedChatRequest: {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: '继续执行任务' }],
      tools: []
    }
  };
}

async function runStopRequest(args) {
  const adapterContext = createAdapterContext(args);
  const result = await args.runServerToolOrchestration({
    chat: createStopChat(args.assistantText ?? '阶段完成。'),
    adapterContext,
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    clientInjectDispatch: async (injectArgs) => {
      if (args.capture) {
        args.capture.args = injectArgs;
      }
      return { ok: true };
    },
    reenterPipeline: async (reenterArgs) => {
      return { body: createStopChat('ok') };
    }
  });
  return result;
}

async function runCounterRegression(args) {
  const sessionId = `stop-counter-${Date.now()}`;
  const tmuxSessionId = `tmux_${sessionId}`;
  const stickyKey = `tmux:${tmuxSessionId}`;

  const first = await runStopRequest({
    runServerToolOrchestration: args.runServerToolOrchestration,
    sessionId,
    requestId: `${sessionId}-1`,
    includeRuntimeState: true,
    tmuxSessionId,
    stopMessageText: '继续执行',
    stopMessageMaxRepeats: 2
  });
  assert.equal(first.executed, true, 'first request should trigger stop_message_flow');
  assert.equal(first.flowId, 'stop_message_flow');

  const stateAfterFirst = args.loadRoutingInstructionStateSync(stickyKey);
  assert.ok(stateAfterFirst, 'sticky state should exist after first stop followup');
  assert.equal(stateAfterFirst.stopMessageUsed, 1, 'used counter should increment to 1');

  const second = await runStopRequest({
    runServerToolOrchestration: args.runServerToolOrchestration,
    sessionId,
    requestId: `${sessionId}-2`,
    includeRuntimeState: false,
    tmuxSessionId,
    stopMessageText: '',
    stopMessageMaxRepeats: 0
  });
  assert.equal(second.executed, true, 'second request should still trigger before max repeats');
  assert.equal(second.flowId, 'stop_message_flow');

  const stateAfterSecond = args.loadRoutingInstructionStateSync(stickyKey);
  assert.ok(stateAfterSecond, 'state record should remain for cleared lifecycle stamp');
  assert.equal(stateAfterSecond.stopMessageText, undefined, 'stopMessageText should be cleared after hitting max repeats');
  assert.equal(stateAfterSecond.stopMessageMaxRepeats, undefined, 'stopMessageMaxRepeats should be cleared after hitting max repeats');
  assert.equal(stateAfterSecond.stopMessageUsed, undefined, 'stopMessageUsed should be cleared after hitting max repeats');
  assert.equal(
    typeof stateAfterSecond.stopMessageUpdatedAt,
    'number',
    'stopMessageUpdatedAt should be persisted after max-repeat clear'
  );

  const third = await runStopRequest({
    runServerToolOrchestration: args.runServerToolOrchestration,
    sessionId,
    requestId: `${sessionId}-3`,
    includeRuntimeState: false,
    tmuxSessionId,
    stopMessageText: '',
    stopMessageMaxRepeats: 0
  });
  assert.equal(third.executed, false, 'third request should stop after reaching max repeats');

  const stateAfterThird = args.loadRoutingInstructionStateSync(stickyKey);
  assert.ok(stateAfterThird, 'state record should remain cleared after max repeats');
  assert.equal(stateAfterThird.stopMessageText, undefined, 'stopMessageText should remain cleared after max repeats');
  assert.equal(stateAfterThird.stopMessageMaxRepeats, undefined, 'stopMessageMaxRepeats should remain cleared after max repeats');
}

async function runFallbackRegression(args) {
  const sessionId = `stop-fallback-${Date.now()}`;
  const tmuxSessionId = `tmux_${sessionId}`;
  const stickyKey = `tmux:${tmuxSessionId}`;
  const capture = {};

  const result = await runStopRequest({
    runServerToolOrchestration: args.runServerToolOrchestration,
    sessionId,
    requestId: `${sessionId}-1`,
    includeRuntimeState: true,
    tmuxSessionId,
    stopMessageText: '请继续推进',
    stopMessageMaxRepeats: 2,
    stopMessageAiMode: 'on',
    assistantText: '先执行',
    capture
  });
  assert.equal(result.executed, true, 'fallback case should still execute stop_message_flow');
  assert.equal(result.flowId, 'stop_message_flow');

  const followup = capture.args;
  assert.ok(followup && typeof followup === 'object', 'followup args should exist');
  const metadata = followup.metadata && typeof followup.metadata === 'object' ? followup.metadata : {};
  assert.equal(metadata.clientInjectOnly, true, 'stop_message should use clientInjectOnly followup');
  const injectText = typeof metadata.clientInjectText === 'string' ? metadata.clientInjectText : '';
  assert.ok(
    injectText.includes('继续执行'),
    `fallback followup should never be empty, got: ${injectText}`
  );
  assert.ok(
    injectText.includes('不要进行状态汇总'),
    `fallback followup should include execution-only hard constraint, got: ${injectText}`
  );
  if (typeof args.loadRoutingInstructionStateSync === 'function') {
    const stateAfterFirst = args.loadRoutingInstructionStateSync(stickyKey);
    assert.ok(stateAfterFirst, 'ai mode fallback should persist stopMessage session state');
    assert.ok(
      Array.isArray(stateAfterFirst.stopMessageAiHistory) && stateAfterFirst.stopMessageAiHistory.length >= 1,
      'ai mode fallback should persist followup history entries'
    );
  }
}

async function runDoneMarkerStripRegression(args) {
  const sessionId = `stop-marker-strip-${Date.now()}`;
  const tmuxSessionId = `tmux_${sessionId}`;
  const capture = {};
  const markerOnlyBin = path.join(args.tmpRoot, 'mock-iflow-marker-only.js');
  await fs.writeFile(
    markerOnlyBin,
    ['#!/usr/bin/env node', "process.stdout.write('[STOPMESSAGE_DONE]');"].join('\n'),
    'utf8'
  );
  await fs.chmod(markerOnlyBin, 0o755);

  process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '1';
  process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'iflow';
  process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = markerOnlyBin;
  process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS = '1000';

  const result = await runStopRequest({
    runServerToolOrchestration: args.runServerToolOrchestration,
    sessionId,
    requestId: `${sessionId}-1`,
    includeRuntimeState: true,
    tmuxSessionId,
    stopMessageText: '请继续推进',
    stopMessageMaxRepeats: 2,
    stopMessageAiMode: 'on',
    assistantText: '继续',
    capture
  });
  assert.equal(result.executed, true, 'marker-only ai output should still execute stop_message_flow');

  const followup = capture.args;
  assert.ok(followup && typeof followup === 'object', 'followup args should exist');
  const metadata = followup.metadata && typeof followup.metadata === 'object' ? followup.metadata : {};
  const content = typeof metadata.clientInjectText === 'string' ? metadata.clientInjectText : '';
  assert.equal(metadata.clientInjectOnly, true, 'marker-only case should use clientInjectOnly followup');
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  assert.notEqual(firstLine.trim(), '[STOPMESSAGE_DONE]', 'done marker should be stripped before followup injection');
  assert.ok(content.includes('继续执行'), 'marker-only output should fallback to continue execution');
  assert.ok(
    !content.includes('[STOPMESSAGE_DONE]'),
    'followup should not contain completion marker token'
  );
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');
  const { loadRoutingInstructionStateSync } = await importModule('router/virtual-router/sticky-session-store.js');

  const originalHome = process.env.HOME;
  const originalUserDir = process.env.ROUTECODEX_USER_DIR;
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const originalAutoEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
  const originalAutoIflow = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
  const originalAutoIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
  const originalAutoTimeout = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_TIMEOUT_MS;
  const originalAiEnabled = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
  const originalAiBackend = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
  const originalAiIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
  const originalAiTimeout = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS;

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-message-counter-'));
  const userDir = path.join(tmpRoot, 'user');
  const sessionDir = path.join(userDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });

  process.env.HOME = tmpRoot;
  process.env.ROUTECODEX_USER_DIR = userDir;
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  try {
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = '0';
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '0';
    await runCounterRegression({ runServerToolOrchestration, loadRoutingInstructionStateSync });

    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'iflow';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = path.join(tmpRoot, 'missing-iflow-bin');
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS = '500';
    await runFallbackRegression({ runServerToolOrchestration, loadRoutingInstructionStateSync });
    await runDoneMarkerStripRegression({ runServerToolOrchestration, tmpRoot });

    console.log('✅ stop-message counter + fallback regression passed');
  } finally {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (typeof originalUserDir === 'string') {
      process.env.ROUTECODEX_USER_DIR = originalUserDir;
    } else {
      delete process.env.ROUTECODEX_USER_DIR;
    }
    if (typeof originalSessionDir === 'string') {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    } else {
      delete process.env.ROUTECODEX_SESSION_DIR;
    }
    if (typeof originalAutoEnabled === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = originalAutoEnabled;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
    }
    if (typeof originalAutoIflow === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = originalAutoIflow;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    }
    if (typeof originalAutoIflowBin === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = originalAutoIflowBin;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    }
    if (typeof originalAutoTimeout === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_TIMEOUT_MS = originalAutoTimeout;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_TIMEOUT_MS;
    }
    if (typeof originalAiEnabled === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = originalAiEnabled;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
    }
    if (typeof originalAiBackend === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = originalAiBackend;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    }
    if (typeof originalAiIflowBin === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = originalAiIflowBin;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    }
    if (typeof originalAiTimeout === 'string') {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS = originalAiTimeout;
    } else {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS;
    }
  }
}

main().catch((error) => {
  console.error('❌ stop-message counter + fallback regression failed:', error);
  process.exit(1);
});
