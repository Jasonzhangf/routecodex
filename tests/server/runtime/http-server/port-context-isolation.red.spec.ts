import { describe, expect, it } from '@jest/globals';

import { buildHttpHandlerContext } from '../../../../src/server/runtime/http-server/http-server-lifecycle.js';
import { RouteCodexHttpServer } from '../../../../src/server/runtime/http-server/index.js';

describe('http server port context isolation red tests', () => {
  it('exposes matched port and routing group on handler context for downstream logs and snapshots', async () => {
    const server = {
      errorHandling: null,
      getPortConfigForLocalPort: (port: number) => port === 5555
        ? { port: 5555, mode: 'router', routingPolicyGroup: 'gateway_priority_5555' }
        : undefined,
      getPortConfigs: () => [{ port: 5555, mode: 'router', routingPolicyGroup: 'gateway_priority_5555' }],
      executePortAwarePipeline: async () => ({ status: 200, body: {} })
    };
    const req = {
      socket: { localPort: 5555 },
      headers: { host: '127.0.0.1:5555' },
      path: '/v1/responses'
    };

    const ctx = buildHttpHandlerContext(server, req as any) as any;

    expect(ctx.portContext).toEqual({
      localPort: 5555,
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555',
      logNamespace: 'server-5555',
      stopMessageEnabled: true,
      stopMessageExcludeDirect: true
    });
  });

  it('does not fall back to the global hub pipeline when a port routing group pipeline is missing', () => {
    const server = new RouteCodexHttpServer({
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    } as any) as any;
    const globalPipeline = { id: 'global' };
    const groupPipeline = { id: 'gateway_priority_5555' };
    server.hubPipeline = globalPipeline;
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', groupPipeline]
    ]);

    expect(server.resolveHubPipelineForRoutingPolicyGroup('gateway_priority_5555')).toBe(groupPipeline);
    expect(server.resolveHubPipelineForRoutingPolicyGroup('gateway_priority_missing')).toBeNull();
    expect(server.resolveHubPipelineForRoutingPolicyGroup()).toBe(globalPipeline);
  });

});
