import * as fs from 'node:fs';
import * as path from 'node:path';
import { jest } from '@jest/globals';

import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import {
  buildHeartbeatInjectText,
  loadHeartbeatState,
  saveHeartbeatState,
  resetHeartbeatRuntimeHooksForTests,
  runHeartbeatDaemonTickForTests,
  setHeartbeatEnabled,
  startHeartbeatDaemonIfNeeded,
  setHeartbeatRuntimeHooks,
  stopHeartbeatDaemonForTests
} from '../../sharedmodule/llmswitch-core/src/servertool/heartbeat/task-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-heartbeat-sessions');

function resetSessionDir(): void {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function buildRequest(messages: StandardizedRequest['messages']): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages,
    tools: [],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('servertool:heartbeat', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(async () => {
    resetSessionDir();
    resetHeartbeatRuntimeHooksForTests();
    await stopHeartbeatDaemonForTests();
  });

  afterAll(async () => {
    resetHeartbeatRuntimeHooksForTests();
    await stopHeartbeatDaemonForTests();
  });

  test('<**hb:on**> only applies to latest user message and strips marker', async () => {
    const tmuxSessionId = 'hb-latest-user';
    const request1 = buildRequest([
      { role: 'user', content: '<**hb:on**>\nold' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new' }
    ]);
    await runReqProcessStage1ToolGovernance({
      request: request1,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-1'
    });
    expect((await loadHeartbeatState(tmuxSessionId)).enabled).toBe(false);

    const request2 = buildRequest([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'please start\n<**hb:on**>\nthanks' }
    ]);
    const result = await runReqProcessStage1ToolGovernance({
      request: request2,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-2'
    });
    const processed = result.processedRequest as StandardizedRequest;
    const lastUser = processed.messages.findLast((item) => item.role === 'user');
    expect(typeof lastUser?.content === 'string' ? lastUser.content : '').not.toContain('hb:on');
    expect((await loadHeartbeatState(tmuxSessionId)).enabled).toBe(true);
  });

  test('<**hb:off**> disables persisted heartbeat state', async () => {
    const tmuxSessionId = 'hb-disable';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-on'
    });
    expect((await loadHeartbeatState(tmuxSessionId)).enabled).toBe(true);

    const result = await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: 'stop\n<**hb:off**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-off'
    });
    const processed = result.processedRequest as StandardizedRequest;
    expect(typeof processed.messages[0]?.content === 'string' ? processed.messages[0].content : '').not.toContain('hb:off');
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.enabled).toBe(false);
    expect(state.lastSkippedReason).toBe('disabled_by_directive');
  });



  test('invalid or unterminated hb markers are stripped without changing heartbeat state', async () => {
    const tmuxSessionId = 'hb-invalid-strip';
    const invalidResult = await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: 'keep\n<**hb:wat**>\ntext' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-invalid-strip'
    });
    const invalidProcessed = invalidResult.processedRequest as StandardizedRequest;
    const invalidContent = typeof invalidProcessed.messages[0]?.content === 'string' ? invalidProcessed.messages[0].content : '';
    expect(invalidContent).not.toContain('<**hb:');
    expect(invalidContent).toContain('keep');
    expect(invalidContent).toContain('text');
    expect((await loadHeartbeatState(tmuxSessionId)).enabled).toBe(false);

    const unterminatedResult = await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: 'line\n<**hb:broken' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-unterminated-strip'
    });
    const unterminatedProcessed = unterminatedResult.processedRequest as StandardizedRequest;
    const unterminatedContent = typeof unterminatedProcessed.messages[0]?.content === 'string' ? unterminatedProcessed.messages[0].content : '';
    expect(unterminatedContent).not.toContain('<**hb:');
    expect(unterminatedContent).toContain('line');
    expect((await loadHeartbeatState(tmuxSessionId)).enabled).toBe(false);
  });

  test('<**hb:15m**> enables heartbeat with interval override, and later <**hb:on**> clears it', async () => {
    const tmuxSessionId = 'hb-interval-override';
    const overrideResult = await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: 'start\n<**hb:15m**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-15m'
    });
    const overrideProcessed = overrideResult.processedRequest as StandardizedRequest;
    expect(typeof overrideProcessed.messages[0]?.content === 'string' ? overrideProcessed.messages[0].content : '').not.toContain('hb:15m');
    expect(await loadHeartbeatState(tmuxSessionId)).toEqual(
      expect.objectContaining({
        enabled: true,
        intervalMs: 15 * 60_000
      })
    );

    const resetResult = await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: 'default\n<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-reset'
    });
    const resetProcessed = resetResult.processedRequest as StandardizedRequest;
    expect(typeof resetProcessed.messages[0]?.content === 'string' ? resetProcessed.messages[0].content : '').not.toContain('hb:on');
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.enabled).toBe(true);
    expect(state.intervalMs).toBeUndefined();
  });

  test('heartbeat interval override uses state interval instead of global daemon tick', async () => {
    const tmuxSessionId = 'hb-effective-interval';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:15m**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-effective-interval'
    });

    const beforeTick = await loadHeartbeatState(tmuxSessionId);
    await saveHeartbeatState({
      ...beforeTick,
      lastTriggeredAtMs: Date.now() - 20 * 60_000,
      triggerCount: 1
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: true }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });

    await startHeartbeatDaemonIfNeeded({ tickMs: 30 * 60_000 });

    expect(dispatchHeartbeat).toHaveBeenCalledTimes(1);
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.triggerCount).toBe(2);
    expect(state.intervalMs).toBe(15 * 60_000);
  });

  test('plain <**hb:on**> clears prior interval override and falls back to default heartbeat interval', async () => {
    const tmuxSessionId = 'hb-clear-override';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:15m**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-clear-override-15m'
    });
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-clear-override-on'
    });

    const beforeTick = await loadHeartbeatState(tmuxSessionId);
    await saveHeartbeatState({
      ...beforeTick,
      lastTriggeredAtMs: Date.now() - 20 * 60_000,
      triggerCount: 1
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: true }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });

    await startHeartbeatDaemonIfNeeded({ tickMs: 30 * 60_000 });

    expect(dispatchHeartbeat).not.toHaveBeenCalled();
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.triggerCount).toBe(1);
    expect(state.intervalMs).toBeUndefined();
  });

  test('daemon tick dispatches heartbeat injection when due', async () => {
    const tmuxSessionId = 'hb-dispatch';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-dispatch'
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: true }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });
    await runHeartbeatDaemonTickForTests();
    expect(dispatchHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId,
        injectText: buildHeartbeatInjectText()
      })
    );
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.enabled).toBe(true);
    expect(state.triggerCount).toBe(1);
    expect(typeof state.lastTriggeredAtMs).toBe('number');
  });

  test('daemon tick records skip reason and disables expired sessions', async () => {
    const tmuxSessionId = 'hb-expired';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-expired'
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: false, disable: true, reason: 'heartbeat_until_expired' }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });
    await runHeartbeatDaemonTickForTests();
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.enabled).toBe(false);
    expect(state.lastError).toBe('heartbeat_until_expired');
  });

  test('daemon tick disables heartbeat when HEARTBEAT.md is missing', async () => {
    const tmuxSessionId = 'hb-missing-file';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-missing-file'
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: false, disable: true, reason: 'heartbeat_file_missing' }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });
    await runHeartbeatDaemonTickForTests();
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.enabled).toBe(false);
    expect(state.lastError).toBe('heartbeat_file_missing');
  });

  test('startup tick followed by immediate manual tick does not double-dispatch same heartbeat', async () => {
    const tmuxSessionId = 'hb-no-duplicate-on-start';
    await runReqProcessStage1ToolGovernance({
      request: buildRequest([{ role: 'user', content: '<**hb:on**>' }]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-hb-no-dup'
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: true }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat
    });

    await startHeartbeatDaemonIfNeeded({ tickMs: 900000 });
    await runHeartbeatDaemonTickForTests();

    expect(dispatchHeartbeat).toHaveBeenCalledTimes(1);
    const state = await loadHeartbeatState(tmuxSessionId);
    expect(state.triggerCount).toBe(1);
  });

  test('port-scoped session dir persists heartbeat under tmux-global store root', async () => {
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const portScopedSessionDir = path.join(SESSION_DIR, '127.0.0.1_5520');
    fs.mkdirSync(portScopedSessionDir, { recursive: true });
    process.env.ROUTECODEX_SESSION_DIR = portScopedSessionDir;

    try {
      const tmuxSessionId = 'hb-global-store';
      await setHeartbeatEnabled(tmuxSessionId, true);

      const globalStateFile = path.join(SESSION_DIR, 'heartbeat', `${tmuxSessionId}.json`);
      const legacyScopedStateFile = path.join(portScopedSessionDir, 'heartbeat', `${tmuxSessionId}.json`);

      expect(fs.existsSync(globalStateFile)).toBe(true);
      expect(fs.existsSync(legacyScopedStateFile)).toBe(false);
    } finally {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    }
  });

  test('loadHeartbeatState migrates legacy per-port heartbeat file into tmux-global store', async () => {
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const portScopedSessionDir = path.join(SESSION_DIR, '127.0.0.1_5520');
    const legacyHeartbeatDir = path.join(portScopedSessionDir, 'heartbeat');
    const tmuxSessionId = 'hb-legacy';
    const legacyFile = path.join(legacyHeartbeatDir, `${tmuxSessionId}.json`);
    fs.mkdirSync(legacyHeartbeatDir, { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        version: 1,
        tmuxSessionId,
        enabled: true,
        updatedAtMs: 123,
        triggerCount: 2,
        lastTriggeredAtMs: 120
      }),
      'utf8'
    );
    process.env.ROUTECODEX_SESSION_DIR = portScopedSessionDir;

    try {
      const state = await loadHeartbeatState(tmuxSessionId);
      const globalStateFile = path.join(SESSION_DIR, 'heartbeat', `${tmuxSessionId}.json`);

      expect(state.enabled).toBe(true);
      expect(state.triggerCount).toBe(2);
      expect(state.lastTriggeredAtMs).toBe(120);
      expect(fs.existsSync(globalStateFile)).toBe(true);
      expect(fs.existsSync(legacyFile)).toBe(false);
    } finally {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    }
  });
});
