import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import http, { type Server } from 'node:http';

import { registerHttpRoutes } from '../../../../src/server/runtime/http-server/routes.js';

function listen(app: express.Application): Promise<{ server: Server; port: number }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('missing-listen-address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('http virtual router diagnostics', () => {
  const openedServers: Server[] = [];

  afterEach(async () => {
    while (openedServers.length > 0) {
      await close(openedServers.pop() as Server);
    }
  });

  it('projects Rust VR status without recomputing route details in TS', async () => {
    const status = {
      routes: {
        default: {
          pools: [{ routeName: 'default', poolId: 'default-primary' }]
        }
      }
    };
    const virtualRouter = {
      getStatus: () => status,
      diagnoseRoute: () => ({ ok: true })
    };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    registerHttpRoutes({
      app,
      config: { server: { host: '127.0.0.1', port: 0 } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      getHubPipeline: () => ({ getVirtualRouter: () => virtualRouter }),
      handleError: async () => undefined,
      getServerId: () => 'routecodex:5520'
    });

    const { server, port } = await listen(app);
    openedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/_routecodex/diagnostics/virtual-router/status`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      serverId: 'routecodex:5520',
      localPort: port,
      virtualRouter: status
    });
  });

  it('ignores removed provider probe query on virtual router status', async () => {
    const status = {
      routes: {
        default: {
          pools: [{ routeName: 'default', poolId: 'default-primary' }]
        }
      }
    };
    const virtualRouter = {
      getStatus: () => status,
      diagnoseRoute: () => ({ ok: true })
    };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    registerHttpRoutes({
      app,
      config: { server: { host: '127.0.0.1', port: 0 } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      getHubPipeline: () => ({ getVirtualRouter: () => virtualRouter }),
      handleError: async () => undefined,
      getServerId: () => 'routecodex:5520'
    });

    const { server, port } = await listen(app);
    openedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/_routecodex/diagnostics/virtual-router/status?probe=1`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      serverId: 'routecodex:5520',
      localPort: port,
      virtualRouter: status
    });
    expect(body).not.toHaveProperty('providerProbe');
  });

  it('projects Rust VR dry-run diagnostics without re-running selection in TS', async () => {
    const diagnostics = {
      ok: true,
      decision: {
        selectedRouteName: 'default',
        selectedProviderKey: 'sdfv.key1.gpt-test'
      }
    };
    const virtualRouter = {
      getStatus: () => ({ routes: {} }),
      diagnoseRoute: (request: unknown, metadata: unknown) => ({
        ...diagnostics,
        request,
        metadata
      })
    };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    registerHttpRoutes({
      app,
      config: { server: { host: '127.0.0.1', port: 0 } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      getHubPipeline: () => ({ getVirtualRouter: () => virtualRouter }),
      handleError: async () => undefined,
      getServerId: () => 'routecodex:5520'
    });

    const { server, port } = await listen(app);
    openedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/_routecodex/diagnostics/virtual-router/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: { messages: [{ role: 'user', content: 'hello' }] },
        metadata: { requestId: 'req-1' }
      })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      serverId: 'routecodex:5520',
      localPort: port,
      diagnostics: {
        ...diagnostics,
        request: { messages: [{ role: 'user', content: 'hello' }] },
        metadata: { requestId: 'req-1' }
      }
    });
  });

  it('selects the diagnostics pipeline by listener port routing policy group', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const portGroups = new Map<number, string>();
    const requestedGroups: Array<string | undefined> = [];
    registerHttpRoutes({
      app,
      config: { server: { host: '127.0.0.1', port: 0 } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      getPortConfigs: () => Array.from(portGroups.entries()).map(([port, routingPolicyGroup]) => ({
        port,
        mode: 'router',
        routingPolicyGroup
      })),
      getHubPipeline: (routingPolicyGroup?: string) => {
        requestedGroups.push(routingPolicyGroup);
        return {
          getVirtualRouter: () => ({
            getStatus: () => ({
              routes: {
                [`${routingPolicyGroup}:default`]: {
                  pools: [{ routeName: `${routingPolicyGroup}:default` }]
                }
              }
            })
          })
        };
      },
      handleError: async () => undefined,
      getServerId: () => 'routecodex:multi'
    });

    const first = await listen(app);
    const second = await listen(app);
    openedServers.push(first.server, second.server);
    portGroups.set(first.port, 'gateway_first');
    portGroups.set(second.port, 'gateway_second');

    const firstBody = await (await fetch(`http://127.0.0.1:${first.port}/_routecodex/diagnostics/virtual-router/status`)).json();
    const secondBody = await (await fetch(`http://127.0.0.1:${second.port}/_routecodex/diagnostics/virtual-router/status`)).json();

    expect(requestedGroups).toEqual(['gateway_first', 'gateway_second']);
    expect(firstBody.localPort).toBe(first.port);
    expect(firstBody.routingPolicyGroup).toBe('gateway_first');
    expect(secondBody.localPort).toBe(second.port);
    expect(secondBody.routingPolicyGroup).toBe('gateway_second');
    expect(Object.keys(firstBody.virtualRouter.routes)).toEqual(['gateway_first:default']);
    expect(Object.keys(secondBody.virtualRouter.routes)).toEqual(['gateway_second:default']);
  });
});
