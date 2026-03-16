import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const clearStopMessageTmuxScope = jest.fn(() => ({ cleared: true, reason: 'test', scope: 'tmux:rcc_dead' }));

const mockBridgeModule = () => ({
  buildHeartbeatInjectTextSnapshot: jest.fn(async () => '[Heartbeat]'),
  cancelClockTaskSnapshot: jest.fn(async () => false),
  clearClockTasksSnapshot: jest.fn(async () => 0),
  listHeartbeatStatesSnapshot: jest.fn(async () => []),
  listClockSessionIdsSnapshot: jest.fn(async () => []),
  listClockTasksSnapshot: jest.fn(async () => []),
  loadHeartbeatStateSnapshot: jest.fn(async () => null),
  resolveClockConfigSnapshot: jest.fn(async () => ({ ok: true })),
  scheduleClockTasksSnapshot: jest.fn(async () => ({ ok: true })),
  setHeartbeatRuntimeHooksSnapshot: jest.fn(async () => true),
  setHeartbeatEnabledSnapshot: jest.fn(async () => ({ enabled: true })),
  updateClockTaskSnapshot: jest.fn(async () => ({ ok: true }))
});

const mockStopMessageModule = () => ({
  clearStopMessageTmuxScope,
  migrateStopMessageTmuxScope: jest.fn(() => ({ migrated: false, clearedOld: false, reason: 'noop' }))
});

const mockTmuxProbeModule = () => ({
  injectTmuxSessionText: jest.fn(async () => ({ ok: true })),
  isTmuxSessionAlive: jest.fn((tmuxSessionId: string) => tmuxSessionId !== 'rcc_dead'),
  resolveTmuxSessionWorkingDirectory: jest.fn(() => '/tmp/mock-heartbeat')
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../src/server/runtime/http-server/stopmessage-scope-rebind.js', mockStopMessageModule);
jest.unstable_mockModule('../../../src/server/runtime/http-server/stopmessage-scope-rebind.ts', mockStopMessageModule);
jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.js', mockTmuxProbeModule);
jest.unstable_mockModule('../../../src/server/runtime/http-server/tmux-session-probe.ts', mockTmuxProbeModule);

function localFetch(baseUrl: string, path: string, body?: unknown): Promise<{ status: number; payload: any }> {
  return (async () => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    return { status: response.status, payload };
  })();
}

describe('session-client cleanup clears stopMessage state', () => {
  it('clears stopMessage for dead tmux sessions during cleanup', async () => {
    jest.resetModules();
    clearStopMessageTmuxScope.mockClear();
    const { registerSessionClientRoutes } = await import(
      '../../../src/server/runtime/http-server/session-client-routes.js'
    );

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerSessionClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const reg = await localFetch(baseUrl, '/daemon/session-client/register', {
        daemonId: 'sessiond_dead_tmux',
        callbackUrl: 'http://127.0.0.1:65531/inject',
        tmuxSessionId: 'rcc_dead',
        tmuxTarget: 'rcc_dead:0.0',
        clientType: 'unit-test'
      });
      expect(reg.status).toBe(200);

      const cleanup = await localFetch(baseUrl, '/daemon/session/cleanup', { mode: 'dead_tmux' });
      expect(cleanup.status).toBe(200);
      expect(clearStopMessageTmuxScope).toHaveBeenCalledWith(
        expect.objectContaining({
          tmuxSessionId: 'rcc_dead',
          reason: 'session_cleanup_dead_tmux'
        })
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('clears stopMessage when explicit tmux unbind is requested', async () => {
    jest.resetModules();
    clearStopMessageTmuxScope.mockClear();
    const { registerSessionClientRoutes } = await import(
      '../../../src/server/runtime/http-server/session-client-routes.js'
    );

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerSessionClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const cleanup = await localFetch(baseUrl, '/daemon/session/cleanup', {
        mode: 'unbind',
        sessionScope: 'tmux:rcc_unbind_test'
      });
      expect(cleanup.status).toBe(200);
      expect(clearStopMessageTmuxScope).toHaveBeenCalledWith(
        expect.objectContaining({
          tmuxSessionId: 'rcc_unbind_test',
          reason: 'session_unbind'
        })
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
