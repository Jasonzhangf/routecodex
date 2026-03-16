import * as fs from 'node:fs';
import * as path from 'node:path';
import { jest } from '@jest/globals';

import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import {
  buildHeartbeatInjectText,
  loadHeartbeatState,
  resetHeartbeatRuntimeHooksForTests,
  runHeartbeatDaemonTickForTests,
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
});
