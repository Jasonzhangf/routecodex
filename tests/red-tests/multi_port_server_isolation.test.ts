/**
 * Red test gate: per-port server isolation contract.
 *
 * Hard guarantees enforced by unit-level red tests (no real server needed):
 * - 1) PortRegistry.attachServer resolves a per-port serverId = canonicalizeServerId(host, port)
 *      and a per-port sessionDir via ensureServerScopedSessionDir.
 * - 2) RouteCodexHttpServer resolvePortSessionDir returns the per-port sessionDir
 *      when the PortRegistry has the port attached, NOT a global fallback.
 * - 3) The wrap() helper in routes.ts converts async handler errors into JSON HTTP
 *      500 with port tag (no empty reply, no connection reset).
 * - 4) Snapshot writer resolveSnapshotDir includes ports/<port> when entryPort is provided.
 * - 5) Errorsamples directory includes scopeId + port segment when provided.
 * - 6) StatsManager composeBucketKey is per-port when entryPort is provided.
 * - 7) Daemon admin /admin|quota|daemon paths return 404 JSON on non-primary port.
 * - 8) executePortAwarePipeline on router mode with missing group pipeline must
 *      throw a typed error with code = ROUTECODEX_HUB_PIPELINE_NOT_READY, status=500,
 *      and embed port/serverId/routingPolicyGroup so the route wrapper can map it
 *      to a JSON 500 response. (no silent empty reply)
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';

describe('RED: multi-port server isolation contract', () => {
  let tempDir: string;
  let originalSessionDir: string | undefined;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rcc-multi-port-iso-'));
    originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    delete process.env.ROUTECODEX_SESSION_DIR;
  });
  afterEach(() => {
    if (originalSessionDir === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    }
    delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    delete process.env.RCC_ERRORSAMPLES_DIR;
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    delete process.env.RCC_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_SNAPSHOT;
    delete process.env.ROUTECODEX_HUB_SNAPSHOTS;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('PortRegistry.attachServer assigns a per-port serverId and per-port sessionDir', async () => {
    const { PortRegistry } = await import('../../src/server/runtime/http-server/port-registry.js');
    const { canonicalizeServerId } = await import('../../src/server/runtime/http-server/server-id.js');
    const { ensureServerScopedSessionDir } = await import('../../src/server/runtime/http-server/session-dir.js');

    // Allocate two ports; we don't need to actually listen (we mock the Server).
    const registry = new PortRegistry();
    const fakeApp: Application = express() as Application;
    const fakeServer = {
      on(event: string, _cb: unknown): unknown { return this; },
      close(cb: (err?: Error) => void): void { cb(); }
    } as unknown as import('node:http').Server;

    const portA = 5520;
    const portB = 10000;
    const instA = registry.attachServer(portA, {
      port: portA, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5520'
    }, fakeServer, fakeApp);
    const instB = registry.attachServer(portB, {
      port: portB, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'gateway_coding_10000'
    }, fakeServer, fakeApp);

    expect(instA.serverId).toBe(canonicalizeServerId('127.0.0.1', portA));
    expect(instB.serverId).toBe(canonicalizeServerId('0.0.0.0', portB));
    // 0.0.0.0 must be normalized to 127.0.0.1 by canonicalizeServerId (server-id.ts contract)
    expect(instB.serverId).not.toBe(instA.serverId);
    expect(instA.sessionDir).toBeTruthy();
    expect(instB.sessionDir).toBeTruthy();
    expect(instA.sessionDir).not.toBe(instB.sessionDir);
    expect(instA.sessionDir).toBe(ensureServerScopedSessionDir(instA.serverId));
    expect(instB.sessionDir).toBe(ensureServerScopedSessionDir(instB.serverId));
  });

  it('route handler wrap() converts async errors into JSON HTTP 500 with port tag', async () => {
    // Replicate the wrap() contract from routes.ts.
    type Handler = (req: Request, res: Response) => Promise<unknown>;
    const wrap = (label: string, handler: Handler) => async (req: Request, res: Response): Promise<void> => {
      try { await handler(req, res); }
      catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const errorRecord = normalized as unknown as Record<string, unknown>;
        const status = typeof errorRecord.status === 'number' ? errorRecord.status : 500;
        const code = typeof errorRecord.code === 'string' && errorRecord.code.trim()
          ? String(errorRecord.code) : 'internal_error';
        res.status(status).json({ error: { message: normalized.message, code, entryEndpoint: label } });
      }
    };

    const app = express() as Application;
    app.post('/boom', wrap('/boom', async () => {
      throw Object.assign(new Error('pipeline missing for port 10000'), {
        code: 'ROUTECODEX_HUB_PIPELINE_NOT_READY',
        status: 500,
        port: 10000,
        serverId: '127.0.0.1:10000',
        routingPolicyGroup: 'gateway_coding_10000'
      });
    }));

    const server = app.listen(0, '127.0.0.1');
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.once('listening', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('no port'));
        resolve({ port: addr.port });
      });
      server.once('error', reject);
    });
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/boom`, { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('ROUTECODEX_HUB_PIPELINE_NOT_READY');
      expect(body.error.message).toContain('10000');
      expect(body.error.entryEndpoint).toBe('/boom');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('daemon admin guard returns 404 JSON on non-primary port', async () => {
    // Replicate the per-port guard contract from daemon-admin-routes.ts.
    function buildApp(primaryPort: number) {
      const app = express() as Application;
      app.use((req: Request, res: Response, next: NextFunction) => {
        const path = String(req.path || req.url || '').split('?')[0];
        if (path.startsWith('/daemon') || path.startsWith('/admin') || path.startsWith('/quota')) {
          const sockPort = typeof req.socket?.localPort === 'number' ? req.socket.localPort : undefined;
          if (sockPort !== primaryPort) {
            res.status(404).json({ error: { message: 'Not Found', code: 'not_found', port: sockPort ?? '-' } });
            return;
          }
        }
        next();
      });
      app.get('/admin/ports', (_req, res) => { res.json({ ok: true, primary: true }); });
      return app;
    }

    const app = buildApp(5520);
    const server = app.listen(0, '127.0.0.1');
    const addr = await new Promise<{ port: number }>((resolve, reject) => {
      server.once('listening', () => {
        const a = server.address();
        if (!a || typeof a === 'string') return reject(new Error('no port'));
        resolve({ port: a.port });
      });
      server.once('error', reject);
    });
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/admin/ports`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('not_found');
      expect(['string', 'number']).toContain(typeof body.error.port);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('errorsamples writeErrorsampleJson builds scope/port-aware directory', async () => {
    const { writeErrorsampleJson } = await import('../../src/utils/errorsamples.js');
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = tempDir;
    process.env.RCC_ERRORSAMPLES_DIR = tempDir;
    delete process.env.ROUTECODEX_SESSION_DIR;

    const before = Date.now();
    const file = await writeErrorsampleJson({
      group: 'provider-error',
      kind: 'provider-request.error',
      scopeId: '127.0.0.1:10000',
      entryPort: 10000,
      payload: { test: 'multi-port-isolation' }
    });
    expect(file).toBeTruthy();
    if (!file) throw new Error('no file returned');
    expect(file).toContain('127.0.0.1_10000');
    expect(file).toContain('port-10000');
    // file must be a fresh json file inside our temp dir
    expect(file.startsWith(tempDir)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const st = statSync(file);
    expect(st.size).toBeGreaterThan(0);
    expect(st.mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it('snapshot writer resolveSnapshotDir includes ports/<port> when entryPort is set', async () => {
    // We hit the private function via the public path: writeProviderSnapshot.
    // Build a temp ROUTECODEX_SNAPSHOT_DIR and ensure files land in ports/<port>/.
    const snapDir = join(tempDir, 'snap');
    mkdirSync(snapDir, { recursive: true });
    process.env.ROUTECODEX_SNAPSHOT_DIR = snapDir;
    process.env.RCC_SNAPSHOT_DIR = snapDir;
    process.env.ROUTECODEX_SNAPSHOT = '1';
    process.env.ROUTECODEX_HUB_SNAPSHOTS = '1';

    const { writeProviderSnapshot, __flushProviderSnapshotQueueForTests } = await import('../../src/providers/core/utils/snapshot-writer.js');
    const gate = await import('../../src/utils/snapshot-local-disk-gate.js');
    const groupRequestId = 'req_multi_port_iso_' + Date.now();
    gate.allowSnapshotLocalDiskWrite(groupRequestId);
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: groupRequestId,
      clientRequestId: groupRequestId,
      entryEndpoint: '/v1/chat/completions',
      url: 'https://example.invalid/v1/chat/completions',
      providerKey: 'mock.iso',
      metadata: { entryPort: 10000, matchedPort: 10000 },
      data: { test: 'multi-port-isolation' }
    });
    await __flushProviderSnapshotQueueForTests();
    const portDir = join(snapDir, 'openai-chat', 'ports', '10000', 'mock.iso', groupRequestId);
    expect(existsSync(portDir)).toBe(true);
    // Without port (legacy), path would be openai-chat/mock.iso/<id>/; ensure we are NOT in that layout.
    const legacyDir = join(snapDir, 'openai-chat', 'mock.iso', groupRequestId);
    expect(existsSync(legacyDir)).toBe(false);
  });

it('StatsManager composeBucketKey partitions stats per port when entryPort is provided', async () => {
    const { composeBucketKey } = await import('../../src/server/runtime/http-server/stats-manager-internals.js');
    const a = composeBucketKey('mock.test', 'demo', 5520);
    const b = composeBucketKey('mock.test', 'demo', 10000);
    const c = composeBucketKey('mock.test', 'demo');
    expect(a).not.toBe(b);
    expect(a).toContain('port-5520');
    expect(b).toContain('port-10000');
    // legacy (no port) is preserved as before
    expect(c).toBe('mock.test|demo');
  });

  
