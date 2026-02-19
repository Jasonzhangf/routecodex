import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { getClockClientRegistry } from '../../../src/server/runtime/http-server/clock-client-registry.js';
import { registerClockClientRoutes } from '../../../src/server/runtime/http-server/clock-client-routes.js';

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

function localFetchByMethod(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  routePath: string,
  body?: unknown
): Promise<{ status: number; payload: any }> {
  return (async () => {
    const response = await fetch(`${baseUrl}${routePath}`, {
      method,
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

describe('clock-client routes', () => {
  jest.setTimeout(20000);

  it('supports register/list/heartbeat/unregister over localhost', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const daemonId = 'clockd_test_1';
      const callbackUrl = 'http://127.0.0.1:65531/inject';

      const reg = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId,
        callbackUrl,
        sessionId: 's_test_1',
        clientType: 'unit-test',
        tmuxTarget: 'dev:0.1'
      });
      expect(reg.status).toBe(200);
      expect(reg.payload?.ok).toBe(true);

      const listRes = await fetch(`${baseUrl}/daemon/clock-client/list`);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson?.ok).toBe(true);
      expect(Array.isArray(listJson?.records)).toBe(true);
      expect(listJson.records.some((entry: any) => entry?.daemonId === daemonId)).toBe(true);

      const hb = await localFetch(baseUrl, '/daemon/clock-client/heartbeat', { daemonId });
      expect(hb.status).toBe(200);
      expect(hb.payload?.ok).toBe(true);

      const unreg = await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId });
      expect(unreg.status).toBe(200);
      expect(unreg.payload?.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('inject supports conversation session mapping bound to tmux session', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let injectHits = 0;
    const callbackServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHits += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));

    const callbackAddr = callbackServer.address() as AddressInfo;
    const callbackUrl = `http://127.0.0.1:${callbackAddr.port}/inject`;

    try {
      const reg = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: 'clockd_mapping',
        callbackUrl,
        tmuxSessionId: 'tmux_mapping_1',
        conversationSessionId: 'conv_mapping_1',
        clientType: 'unit-test'
      });
      expect(reg.status).toBe(200);

      const mappedInject = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-conversation-session',
        sessionId: 'conv_mapping_1'
      });
      expect(mappedInject.status).toBe(200);
      expect(mappedInject.payload?.ok).toBe(true);
      expect(mappedInject.payload?.daemonId).toBe('clockd_mapping');
      expect(injectHits).toBe(1);

      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: 'clockd_mapping' });
    } finally {
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('binds conversation by daemonId hint and injects to matched tmux only', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let injectHitSession1 = 0;
    let injectHitSession2 = 0;

    const callbackServer1 = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitSession1 += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const callbackServer2 = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitSession2 += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => callbackServer1.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => callbackServer2.listen(0, '127.0.0.1', resolve));

    const callbackAddr1 = callbackServer1.address() as AddressInfo;
    const callbackAddr2 = callbackServer2.address() as AddressInfo;

    const daemonId1 = 'clockd_bind_hint_s1';
    const daemonId2 = 'clockd_bind_hint_s2';

    try {
      const reg1 = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonId1,
        callbackUrl: `http://127.0.0.1:${callbackAddr1.port}/inject`,
        tmuxSessionId: 'tmux_bind_1',
        clientType: 'codex'
      });
      expect(reg1.status).toBe(200);

      const reg2 = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonId2,
        callbackUrl: `http://127.0.0.1:${callbackAddr2.port}/inject`,
        tmuxSessionId: 'tmux_bind_2',
        clientType: 'codex'
      });
      expect(reg2.status).toBe(200);

      const bindResult = getClockClientRegistry().bindConversationSession({
        conversationSessionId: 'conv_bind_hint_1',
        daemonId: daemonId2,
        clientType: 'codex'
      });
      expect(bindResult.ok).toBe(true);
      expect(bindResult.daemonId).toBe(daemonId2);
      expect(bindResult.tmuxSessionId).toBe('tmux_bind_2');

      const injected = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-bind-hint',
        sessionId: 'conv_bind_hint_1'
      });
      expect(injected.status).toBe(200);
      expect(injected.payload?.ok).toBe(true);
      expect(injected.payload?.daemonId).toBe(daemonId2);
      expect(injectHitSession1).toBe(0);
      expect(injectHitSession2).toBe(1);
    } finally {
      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonId1 });
      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonId2 });
      await new Promise<void>((resolve) => callbackServer1.close(() => resolve()));
      await new Promise<void>((resolve) => callbackServer2.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('inject enforces strict session matching', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let injectHitSession1 = 0;
    let injectHitSession2 = 0;

    const callbackServer1 = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitSession1 += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const callbackServer2 = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitSession2 += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => callbackServer1.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => callbackServer2.listen(0, '127.0.0.1', resolve));

    const callbackAddr1 = callbackServer1.address() as AddressInfo;
    const callbackAddr2 = callbackServer2.address() as AddressInfo;
    const callbackUrl1 = `http://127.0.0.1:${callbackAddr1.port}/inject`;
    const callbackUrl2 = `http://127.0.0.1:${callbackAddr2.port}/inject`;

    const daemonId1 = 'clockd_strict_s1';
    const daemonId2 = 'clockd_strict_s2';

    try {
      const reg1 = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonId1,
        callbackUrl: callbackUrl1,
        sessionId: 's_clock_1',
        clientType: 'unit-test'
      });
      expect(reg1.status).toBe(200);

      const reg2 = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonId2,
        callbackUrl: callbackUrl2,
        sessionId: 's_clock_2',
        clientType: 'unit-test'
      });
      expect(reg2.status).toBe(200);

      const missingSession = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-without-session'
      });
      expect(missingSession.status).toBe(400);
      expect(missingSession.payload?.error?.message).toBe('tmuxSessionId is required');

      const unmatched = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-unmatched',
        sessionId: 's_not_found'
      });
      expect(unmatched.status).toBe(503);
      expect(unmatched.payload?.reason).toBe('no_matching_tmux_session_daemon');

      const matched = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-session-1',
        sessionId: 's_clock_1'
      });
      expect(matched.status).toBe(200);
      expect(matched.payload?.ok).toBe(true);
      expect(matched.payload?.daemonId).toBe(daemonId1);
      expect(injectHitSession1).toBe(1);
      expect(injectHitSession2).toBe(0);

      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonId1 });
      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonId2 });
    } finally {
      await new Promise<void>((resolve) => callbackServer1.close(() => resolve()));
      await new Promise<void>((resolve) => callbackServer2.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('conversation session injection does not cross tmux sessions across workdirs', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let injectHitA = 0;
    let injectHitB = 0;
    const callbackServerA = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitA += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const callbackServerB = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitB += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => callbackServerA.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => callbackServerB.listen(0, '127.0.0.1', resolve));
    const callbackAddrA = callbackServerA.address() as AddressInfo;
    const callbackAddrB = callbackServerB.address() as AddressInfo;

    const daemonIdA = 'clockd_conv_isolation_a';
    const daemonIdB = 'clockd_conv_isolation_b';
    const tmuxSessionIdA = 'rcc_conv_isolation_a';
    const tmuxSessionIdB = 'rcc_conv_isolation_b';
    const workdirA = '/tmp/routecodex-conv-isolation-a';
    const workdirB = '/tmp/routecodex-conv-isolation-b';

    try {
      const regA = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonIdA,
        callbackUrl: `http://127.0.0.1:${callbackAddrA.port}/inject`,
        tmuxSessionId: tmuxSessionIdA,
        workdir: workdirA,
        clientType: 'unit-test'
      });
      expect(regA.status).toBe(200);

      const regB = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: daemonIdB,
        callbackUrl: `http://127.0.0.1:${callbackAddrB.port}/inject`,
        tmuxSessionId: tmuxSessionIdB,
        workdir: workdirB,
        clientType: 'unit-test'
      });
      expect(regB.status).toBe(200);

      const bind = getClockClientRegistry().bindConversationSession({
        conversationSessionId: 'conv_isolation_a',
        clientType: 'unit-test',
        workdir: workdirA
      });
      expect(bind.ok).toBe(true);
      expect(bind.daemonId).toBe(daemonIdA);

      const injectA = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'conv-a',
        sessionId: 'conv_isolation_a',
        workdir: workdirA
      });
      expect(injectA.status).toBe(200);
      expect(injectA.payload?.daemonId).toBe(daemonIdA);
      expect(injectHitA).toBe(1);
      expect(injectHitB).toBe(0);

      const injectWrongWorkdir = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'conv-a-wrong-workdir',
        sessionId: 'conv_isolation_a',
        workdir: workdirB
      });
      expect(injectWrongWorkdir.status).toBe(503);
      expect(injectWrongWorkdir.payload?.reason).toBe('workdir_mismatch');
      expect(injectHitA).toBe(1);
      expect(injectHitB).toBe(0);
    } finally {
      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonIdA });
      await localFetch(baseUrl, '/daemon/clock-client/unregister', { daemonId: daemonIdB });
      await new Promise<void>((resolve) => callbackServerA.close(() => resolve()));
      await new Promise<void>((resolve) => callbackServerB.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('inject enforces workdir when tmux session id is shared', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    let injectHitA = 0;
    let injectHitB = 0;
    const callbackServerA = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitA += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const callbackServerB = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inject') {
        injectHitB += 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => callbackServerA.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => callbackServerB.listen(0, '127.0.0.1', resolve));
    const callbackAddrA = callbackServerA.address() as AddressInfo;
    const callbackAddrB = callbackServerB.address() as AddressInfo;

    try {
      const sharedTmuxSessionId = 'rcc_shared_workdir_route';
      const regA = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: 'clockd_route_workdir_a',
        callbackUrl: `http://127.0.0.1:${callbackAddrA.port}/inject`,
        tmuxSessionId: sharedTmuxSessionId,
        workdir: '/tmp/routecodex-route-workdir-a'
      });
      expect(regA.status).toBe(200);
      const regB = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: 'clockd_route_workdir_b',
        callbackUrl: `http://127.0.0.1:${callbackAddrB.port}/inject`,
        tmuxSessionId: sharedTmuxSessionId,
        workdir: '/tmp/routecodex-route-workdir-b'
      });
      expect(regB.status).toBe(200);

      const injectA = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-a',
        tmuxSessionId: sharedTmuxSessionId,
        workdir: '/tmp/routecodex-route-workdir-a'
      });
      expect(injectA.status).toBe(200);
      expect(injectA.payload?.daemonId).toBe('clockd_route_workdir_a');
      expect(injectHitA).toBe(1);
      expect(injectHitB).toBe(0);

      const injectB = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-b',
        tmuxSessionId: sharedTmuxSessionId,
        workdir: '/tmp/routecodex-route-workdir-b'
      });
      expect(injectB.status).toBe(200);
      expect(injectB.payload?.daemonId).toBe('clockd_route_workdir_b');
      expect(injectHitA).toBe(1);
      expect(injectHitB).toBe(1);

      const injectMismatch = await localFetch(baseUrl, '/daemon/clock-client/inject', {
        text: 'hello-c',
        tmuxSessionId: sharedTmuxSessionId,
        workdir: '/tmp/routecodex-route-workdir-missing'
      });
      expect(injectMismatch.status).toBe(503);
      expect(injectMismatch.payload?.reason).toBe('workdir_mismatch');
    } finally {
      await new Promise<void>((resolve) => callbackServerA.close(() => resolve()));
      await new Promise<void>((resolve) => callbackServerB.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('supports clock task list + CRUD + recurrence fields', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-clock-routes-'));
    const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    process.env.ROUTECODEX_SESSION_DIR = tmpSessionDir;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const dueAt = new Date(Date.now() + 60_000).toISOString();
      const created = await localFetchByMethod(baseUrl, 'POST', '/daemon/clock/tasks', {
        sessionId: 'conv_clock_crud_1',
        dueAt,
        task: 'run-crud',
        recurrence: { kind: 'interval', everyMinutes: 5, maxRuns: 3 }
      });
      expect(created.status).toBe(200);
      expect(created.payload?.ok).toBe(true);
      expect(created.payload?.scheduledCount).toBe(1);

      const listed = await localFetchByMethod(baseUrl, 'GET', '/daemon/clock/tasks?sessionId=conv_clock_crud_1');
      expect(listed.status).toBe(200);
      expect(listed.payload?.ok).toBe(true);
      expect(Array.isArray(listed.payload?.sessions)).toBe(true);
      expect(listed.payload.sessions[0]?.taskCount).toBe(1);
      const taskId = listed.payload.sessions[0]?.tasks?.[0]?.taskId;
      expect(typeof taskId).toBe('string');
      expect(listed.payload.sessions[0]?.tasks?.[0]?.recurrence?.kind).toBe('interval');

      const patched = await localFetchByMethod(baseUrl, 'PATCH', '/daemon/clock/tasks', {
        sessionId: 'conv_clock_crud_1',
        taskId,
        patch: { task: 'run-crud-updated' }
      });
      expect(patched.status).toBe(200);
      expect(patched.payload?.ok).toBe(true);

      const deleted = await localFetchByMethod(baseUrl, 'DELETE', '/daemon/clock/tasks', {
        sessionId: 'conv_clock_crud_1',
        taskId
      });
      expect(deleted.status).toBe(200);
      expect(deleted.payload?.ok).toBe(true);
      expect(deleted.payload?.removed).toBe(true);

      const listedAfterDelete = await localFetchByMethod(baseUrl, 'GET', '/daemon/clock/tasks?sessionId=conv_clock_crud_1');
      expect(listedAfterDelete.status).toBe(200);
      expect(listedAfterDelete.payload?.sessions?.[0]?.taskCount).toBe(0);
    } finally {
      if (prevSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
      }
      fs.rmSync(tmpSessionDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('clock cleanup clears task sessions for removed tmux session ids', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-clock-cleanup-'));
    const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    process.env.ROUTECODEX_SESSION_DIR = tmpSessionDir;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const tmuxSessionId = `rcc_cleanup_dead_${Date.now()}`;
    try {
      const reg = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: 'clockd_cleanup_dead_1',
        callbackUrl: 'http://127.0.0.1:65530/inject',
        tmuxSessionId
      });
      expect(reg.status).toBe(200);
      expect(reg.payload?.ok).toBe(true);

      const cleanup = await localFetch(baseUrl, '/daemon/clock/cleanup', {
        mode: 'dead_tmux'
      });
      expect(cleanup.status).toBe(200);
      expect(cleanup.payload?.ok).toBe(true);
      expect(cleanup.payload?.cleanup?.removedTmuxSessionIds).toContain(tmuxSessionId);
      expect(cleanup.payload?.clearedTaskSessions).toBeGreaterThanOrEqual(1);
    } finally {
      if (prevSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
      }
      fs.rmSync(tmpSessionDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('clock cleanup does not terminate managed tmux sessions by default', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    registerClockClientRoutes(app);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const tmuxSessionId = `rcc_cleanup_managed_${Date.now()}`;
    try {
      const reg = await localFetch(baseUrl, '/daemon/clock-client/register', {
        daemonId: 'clockd_cleanup_managed_1',
        callbackUrl: 'http://127.0.0.1:65531/inject',
        tmuxSessionId,
        managedTmuxSession: true
      });
      expect(reg.status).toBe(200);
      expect(reg.payload?.ok).toBe(true);

      const cleanup = await localFetch(baseUrl, '/daemon/clock/cleanup', {
        mode: 'dead_tmux'
      });
      expect(cleanup.status).toBe(200);
      expect(cleanup.payload?.ok).toBe(true);
      expect(cleanup.payload?.terminateManaged).toBe(false);
      expect(cleanup.payload?.cleanup?.removedTmuxSessionIds).toContain(tmuxSessionId);
      expect(cleanup.payload?.cleanup?.killedTmuxSessionIds).toEqual([]);
      expect(cleanup.payload?.cleanup?.skippedKillTmuxSessionIds).toContain(tmuxSessionId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
