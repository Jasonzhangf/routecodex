#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function createToolCallsChat() {
  return {
    id: 'chatcmpl_tool_calls',
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
              id: 'call_x',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        }
      }
    ]
  };
}

function createCapturedRequest(overrides = {}) {
  return {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: '继续执行任务' }],
    tools: [],
    ...overrides
  };
}

function createAdapterContext(args) {
  const runtime = args.runtimeState ? { ...args.runtimeState } : {};
  const tmuxSessionId = args.tmuxSessionId || `tmux_${String(args.sessionId || args.requestId || 'unknown')}`;
  return {
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    providerKey: args.providerKey || 'tab.key1.gpt-5.3-codex',
    sessionId: args.sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    __rt: runtime,
    ...(args.capturedChatRequest === undefined ? {} : { capturedChatRequest: args.capturedChatRequest })
  };
}

function toStringEnvValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

async function withEnv(overrides, fn) {
  const backup = new Map();
  for (const key of Object.keys(overrides)) {
    backup.set(key, process.env[key]);
    const next = toStringEnvValue(overrides[key]);
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of backup.entries()) {
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

async function runCase(args) {
  const adapterContext = createAdapterContext(args);
  const capture = {};
  const result = await args.runServerToolOrchestration({
    chat: args.chat,
    adapterContext,
    requestId: args.requestId,
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages',
    clientInjectDispatch: async (injectArgs) => {
      capture.args = injectArgs;
      return { ok: true };
    },
    reenterPipeline: async (reenterArgs) => {
      return { body: createStopChat('ok') };
    }
  });
  const compare = args.readStopMessageCompareContext(adapterContext);
  return { result, compare, followup: capture.args, adapterContext };
}

function runDefaultDisabledCaseInSubprocess(repoRoot) {
  const script = `
import path from 'node:path';
const repoRoot = process.env.TEST_REPO_ROOT;
const runServerToolOrchestration = (await import(path.resolve(repoRoot, 'dist', 'servertool/engine.js'))).runServerToolOrchestration;
const readStopMessageCompareContext = (await import(path.resolve(repoRoot, 'dist', 'servertool/stop-message-compare-context.js'))).readStopMessageCompareContext;
const adapterContext = {
  requestId: 'default-disabled-subprocess',
  entryEndpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages',
  providerKey: 'tab.key1.gpt-5.3-codex',
  sessionId: 'default-disabled-subprocess',
  clientTmuxSessionId: 'tmux_default_disabled_subprocess',
  tmuxSessionId: 'tmux_default_disabled_subprocess',
  __rt: {},
  capturedChatRequest: {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: '继续执行任务' }],
    tools: []
  }
};
const chat = {
  id: 'chatcmpl_stop',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '阶段完成。' } }]
};
const result = await runServerToolOrchestration({
  chat,
  adapterContext,
  requestId: 'default-disabled-subprocess',
  entryEndpoint: '/v1/messages',
  providerProtocol: 'anthropic-messages',
  reenterPipeline: async () => ({ body: chat })
});
const compare = readStopMessageCompareContext(adapterContext);
console.log(JSON.stringify({ executed: result.executed, reason: compare?.reason }));
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_REPO_ROOT: repoRoot,
      ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED: '0',
      ROUTECODEX_STOPMESSAGE_IMPLICIT_GEMINI: '0'
    }
  });
  assert.equal(child.status, 0, `default-disabled subprocess failed: ${child.stderr || child.stdout}`);
  const payload = JSON.parse((child.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
  return payload;
}

async function main() {
  const { runServerToolOrchestration } = await importModule('servertool/engine.js');
  const { readStopMessageCompareContext } = await importModule('servertool/stop-message-compare-context.js');
  const { loadRoutingInstructionStateSync, saveRoutingInstructionStateSync } = await importModule(
    'router/virtual-router/sticky-session-store.js'
  );

  const originalHome = process.env.HOME;
  const originalUserDir = process.env.ROUTECODEX_USER_DIR;
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const originalAutoEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
  const originalAutoIflow = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
  const originalAutoIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
  const originalStopMessageConfigPath = process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
  const originalDefaultEnabled = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
  const originalDefaultText = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
  const originalDefaultMax = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-message-branches-'));
  const userDir = path.join(tmpRoot, 'user');
  const sessionDir = path.join(userDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });

  process.env.HOME = tmpRoot;
  process.env.ROUTECODEX_USER_DIR = userDir;
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;
  process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = path.join(tmpRoot, 'stop-message.json');
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = '0';
  process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '0';
  process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
  process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT = '继续执行';
  process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = '1';

  try {
    const baseSession = `stop-branches-${Date.now()}`;
    let index = 0;
    const nextRequestId = (suffix) => `${baseSession}-${++index}-${suffix}`;

    const noMarkerSkip = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('default-trigger'),
      sessionId: `${baseSession}-default`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest()
    });
    assert.equal(noMarkerSkip.result.executed, false, 'without marker/state stop_message_flow should not trigger');
    assert.equal(noMarkerSkip.compare?.reason, 'skip_default_disabled');

    const skipFollowup = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('followup-skip'),
      sessionId: `${baseSession}-followup`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: {
        serverToolFollowup: true,
        serverToolLoopState: { flowId: 'stop_message_flow' }
      }
    });
    assert.equal(skipFollowup.result.executed, false);
    assert.equal(skipFollowup.compare?.reason, 'skip_followup_request');

    const skipCompactionFlag = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('compaction-flag'),
      sessionId: `${baseSession}-compaction-flag`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: { compactionRequest: true }
    });
    assert.equal(skipCompactionFlag.result.executed, false);
    assert.equal(skipCompactionFlag.compare?.reason, 'skip_compaction_flag');

    const defaultDisabledCase = runDefaultDisabledCaseInSubprocess(repoRoot);
    assert.equal(defaultDisabledCase.executed, false);
    assert.equal(defaultDisabledCase.reason, 'skip_default_disabled');

    const skipExplicitOff = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('explicit-off'),
      sessionId: `${baseSession}-explicit-off`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: {
        stopMessageState: {
          stopMessageStageMode: 'off',
          stopMessageSource: 'explicit'
        }
      }
    });
    assert.equal(skipExplicitOff.result.executed, false);
    assert.equal(skipExplicitOff.compare?.reason, 'skip_explicit_mode_off');

    const skipSnapshotOff = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('snapshot-off'),
      sessionId: `${baseSession}-snapshot-off`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '执行下一步',
          stopMessageMaxRepeats: 1,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'off'
        }
      }
    });
    assert.equal(skipSnapshotOff.result.executed, false);
    assert.equal(skipSnapshotOff.compare?.reason, 'skip_explicit_mode_off');

    const repeatsSession = `${baseSession}-repeats`;
    const repeatsScopeKey = `tmux:tmux_${repeatsSession}`;
    const skipReachedMax = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('max-repeats'),
      sessionId: repeatsSession,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '继续执行',
          stopMessageMaxRepeats: 1,
          stopMessageUsed: 1,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on'
        }
      }
    });
    assert.equal(skipReachedMax.result.executed, false);
    assert.equal(skipReachedMax.compare?.reason, 'skip_reached_max_repeats');
    const cleared = loadRoutingInstructionStateSync(repeatsScopeKey);
    assert.ok(cleared, 'state record should remain for cleared lifecycle stamp');
    assert.equal(cleared.stopMessageText, undefined, 'stopMessageText should be cleared after max repeats');
    assert.equal(cleared.stopMessageMaxRepeats, undefined, 'stopMessageMaxRepeats should be cleared after max repeats');
    assert.equal(cleared.stopMessageUsed, undefined, 'stopMessageUsed should be cleared after max repeats');
    assert.equal(typeof cleared.stopMessageUpdatedAt, 'number', 'stopMessageUpdatedAt should be retained after clear');

    const skipNoState = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('no-state'),
      sessionId: `${baseSession}-no-state`,
      chat: createToolCallsChat(),
      capturedChatRequest: createCapturedRequest()
    });
    assert.equal(skipNoState.result.executed, false);
    assert.equal(skipNoState.compare?.reason, 'skip_default_disabled');

    const skipNotStop = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('not-stop'),
      sessionId: `${baseSession}-not-stop`,
      chat: createToolCallsChat(),
      capturedChatRequest: createCapturedRequest(),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '继续执行',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on'
        }
      }
    });
    assert.equal(skipNotStop.result.executed, false);
    assert.equal(skipNotStop.compare?.reason, 'skip_not_stop_finish_reason');

    const skipNoCaptured = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('no-captured'),
      sessionId: `${baseSession}-no-captured`,
      chat: createStopChat(),
      capturedChatRequest: undefined,
      runtimeState: {
        stopMessageState: {
          stopMessageText: '继续执行',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on'
        }
      }
    });
    assert.equal(skipNoCaptured.result.executed, false);
    assert.equal(skipNoCaptured.compare?.reason, 'skip_no_captured_request');

    const skipCompactionRequest = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('compaction-request'),
      sessionId: `${baseSession}-compaction-request`,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest({
        messages: [{ role: 'user', content: 'Handoff summary for another LLM: checkpoint' }]
      }),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '继续执行',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on'
        }
      }
    });
    assert.equal(skipCompactionRequest.result.executed, false);
    assert.equal(skipCompactionRequest.compare?.reason, 'skip_compaction_request');

    const skipFailedSeed = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('failed-seed'),
      sessionId: `${baseSession}-failed-seed`,
      chat: createStopChat(),
      capturedChatRequest: { model: 'gpt-5.3-codex' },
      runtimeState: {
        stopMessageState: {
          stopMessageText: '继续执行',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on'
        }
      }
    });
    assert.equal(skipFailedSeed.result.executed, false);
    assert.equal(skipFailedSeed.compare?.reason, 'skip_failed_build_followup');

    const stickyOffSession = `${baseSession}-sticky-off`;
    saveRoutingInstructionStateSync(`tmux:tmux_${stickyOffSession}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageSource: 'explicit',
      stopMessageStageMode: 'off',
      stopMessageUpdatedAt: Date.now(),
      stopMessageLastUsedAt: undefined
    });
    const skipStickyOff = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('sticky-off'),
      sessionId: stickyOffSession,
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest()
    });
    assert.equal(skipStickyOff.result.executed, false);
    assert.equal(skipStickyOff.compare?.reason, 'skip_explicit_mode_off');

    const fixedTriggered = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('fixed-triggered'),
      sessionId: `${baseSession}-fixed`,
      providerKey: 'tab.key1.gpt-5.3-codex',
      chat: createStopChat(),
      capturedChatRequest: createCapturedRequest({ model: 'gpt-5.3-codex' }),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '固定继续执行提示',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on',
          stopMessageAiMode: 'off'
        }
      }
    });
    assert.equal(fixedTriggered.result.executed, true);
    assert.equal(fixedTriggered.compare?.reason, 'triggered');
    const fixedMeta = fixedTriggered.followup?.metadata && typeof fixedTriggered.followup.metadata === 'object'
      ? fixedTriggered.followup.metadata
      : {};
    assert.equal(fixedMeta.clientInjectOnly, true);
    assert.ok(
      typeof fixedMeta.clientInjectText === 'string' && fixedMeta.clientInjectText.includes('固定继续执行提示'),
      'ai=off should use configured fixed followup text'
    );

    const markerSession = `${baseSession}-marker-stop`;
    const markerTriggered = await runCase({
      runServerToolOrchestration,
      readStopMessageCompareContext,
      requestId: nextRequestId('done-marker'),
      sessionId: markerSession,
      providerKey: 'iflow.1.kimi-k2.5',
      chat: createStopChat('任务已完成 [STOPMESSAGE_DONE]'),
      capturedChatRequest: createCapturedRequest({ model: 'kimi-k2.5' }),
      runtimeState: {
        stopMessageState: {
          stopMessageText: '推进到目标完成',
          stopMessageMaxRepeats: 2,
          stopMessageUsed: 0,
          stopMessageSource: 'explicit',
          stopMessageStageMode: 'on',
          stopMessageAiMode: 'on'
        }
      }
    });
    assert.equal(markerTriggered.result.executed, true);
    assert.equal(markerTriggered.compare?.reason, 'triggered');
    const markerState = loadRoutingInstructionStateSync(`tmux:tmux_${markerSession}`);
    assert.notEqual(markerState, null, 'main-model done marker should not clear state without reviewer approval');
    assert.equal(markerState?.stopMessageUsed, 1, 'done-marker claim should still consume one followup round');

    const iflowMockBin = path.join(tmpRoot, 'iflow-mock.sh');
    await fs.writeFile(iflowMockBin, '#!/bin/sh\necho "next-step-from-iflow"\n', { mode: 0o755 });

    const iflowTriggered = await withEnv(
      {
        ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED: '1',
        ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND: 'codex',
        ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN: iflowMockBin
      },
      async () =>
        runCase({
          runServerToolOrchestration,
          readStopMessageCompareContext,
          requestId: nextRequestId('iflow-triggered'),
          sessionId: `${baseSession}-iflow`,
          providerKey: 'iflow.1.kimi-k2.5',
          chat: createStopChat(),
          capturedChatRequest: createCapturedRequest({ model: 'kimi-k2.5' }),
          runtimeState: {
            stopMessageState: {
              stopMessageText: '执行A',
              stopMessageMaxRepeats: 2,
              stopMessageUsed: 0,
              stopMessageSource: 'explicit',
              stopMessageStageMode: 'on',
              stopMessageAiMode: 'on'
            }
          }
        })
    );
    assert.equal(iflowTriggered.result.executed, true);
    assert.equal(iflowTriggered.compare?.reason, 'triggered');
    const iflowMeta = iflowTriggered.followup?.metadata && typeof iflowTriggered.followup.metadata === 'object'
      ? iflowTriggered.followup.metadata
      : {};
    assert.equal(iflowMeta.clientInjectOnly, true);
    assert.ok(
      typeof iflowMeta.clientInjectText === 'string' && iflowMeta.clientInjectText.includes('next-step-from-iflow'),
      'iflow result should use generated followup text'
    );

    console.log('✅ stop-message auto branch coverage regression passed');
  } finally {
    if (typeof originalHome === 'string') process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (typeof originalUserDir === 'string') process.env.ROUTECODEX_USER_DIR = originalUserDir;
    else delete process.env.ROUTECODEX_USER_DIR;
    if (typeof originalSessionDir === 'string') process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    else delete process.env.ROUTECODEX_SESSION_DIR;
    if (typeof originalAutoEnabled === 'string') process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED = originalAutoEnabled;
    else delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED;
    if (typeof originalAutoIflow === 'string') process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = originalAutoIflow;
    else delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    if (typeof originalAutoIflowBin === 'string') process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = originalAutoIflowBin;
    else delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    if (typeof originalStopMessageConfigPath === 'string') process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = originalStopMessageConfigPath;
    else delete process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
    if (typeof originalDefaultEnabled === 'string') process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = originalDefaultEnabled;
    else delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    if (typeof originalDefaultText === 'string') process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT = originalDefaultText;
    else delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
    if (typeof originalDefaultMax === 'string') process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = originalDefaultMax;
    else delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  }
}

main().catch((error) => {
  console.error('❌ stop-message auto branch coverage regression failed:', error);
  process.exit(1);
});
