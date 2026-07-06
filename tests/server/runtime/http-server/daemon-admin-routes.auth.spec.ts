import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  isDaemonAdminAuthRequired,
  registerDaemonAdminRoutes,
  rejectNonLocalOrUnauthorizedAdmin,
} from '../../../../src/server/runtime/http-server/daemon-admin-routes.js';

describe('daemon admin auth gate shell', () => {
  it('does not require auth for local daemon-admin requests', () => {
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      app: { locals: {} },
    } as any;

    expect(isDaemonAdminAuthRequired(req)).toBe(false);
  });

  it('requires auth by default for non-local daemon-admin requests', () => {
    const req = {
      socket: { remoteAddress: '10.0.0.8' },
      app: { locals: {} },
    } as any;

    expect(isDaemonAdminAuthRequired(req)).toBe(true);
  });

  it('fails closed with unauthorized when no daemon-admin auth state is established', () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const req = {
      socket: { remoteAddress: '10.0.0.8' },
      app: { locals: {} },
    } as any;
    const res = { status, json } as any;

    expect(rejectNonLocalOrUnauthorizedAdmin(req, res)).toBe(true);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { message: 'unauthorized', code: 'unauthorized' } });
  });

  it('allows config editor writes from a non-config socket port because the UI edits one config file', async () => {
    const previousConfigPath = process.env.ROUTECODEX_CONFIG_PATH;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-admin-config-editor-'));
    const configPath = path.join(tmp, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          version: '1.0.0',
          httpserver: {
            host: '127.0.0.1',
            port: 5520,
            ports: [
              { port: 5520, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'default' }
            ]
          },
          virtualrouter: {
            routingPolicyGroups: {
              default: { routing: { default: [{ targets: ['demo.default.model'] }] } }
            },
            activeRoutingPolicyGroup: 'default'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    process.env.ROUTECODEX_CONFIG_PATH = configPath;
    let server: http.Server | null = null;
    try {
      const app = express();
      app.use(express.json());
      registerDaemonAdminRoutes({
        app,
        getManagerDaemon: () => null,
        getServerId: () => '127.0.0.1:7777',
        getVirtualRouterArtifacts: () => null,
        getConfigPath: () => configPath,
        getServerHost: () => '127.0.0.1',
        getServerPort: () => 5520
      });

      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${baseUrl}/config/editor/ports?path=${encodeURIComponent(configPath)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ports: [
            { port: 7777, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'default' }
          ]
        })
      });
      const body = await res.json();

      expect(addr.port).not.toBe(5520);
      expect(res.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        path: configPath,
        ports: [expect.objectContaining({ port: 7777 })]
      }));
      const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(written.httpserver.ports).toEqual([
        expect.objectContaining({ port: 7777, routingPolicyGroup: 'default' })
      ]);
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.ROUTECODEX_CONFIG_PATH;
      } else {
        process.env.ROUTECODEX_CONFIG_PATH = previousConfigPath;
      }
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve());
        });
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
