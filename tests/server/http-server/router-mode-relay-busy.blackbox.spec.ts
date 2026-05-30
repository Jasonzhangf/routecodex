import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

function buildUserConfig() {
  const provider = (id: string) => ({
    id,
    enabled: true,
    type: 'mock',
    baseURL: `mock://${id}`,
    auth: { type: 'apikey', apiKey: `${id}-key` },
    models: {
      'MiniMax-M2.7': {
        supportsStreaming: true,
        capabilities: ['text', 'tools', 'web_search']
      }
    }
  });
  return {
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ports: [
        {
          name: 'gateway_priority_5555',
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct'
        }
      ]
    },
    virtualrouter: {
      providers: {
        mini27: provider('mini27'),
        minimonth: provider('minimonth')
      },
      routingPolicyGroups: {
        gateway_priority_5555: {
          routing: {
            search: [
              {
                id: 'gateway-priority-5555-search',
                mode: 'weighted',
                targets: ['mini27.MiniMax-M2.7', 'minimonth.MiniMax-M2.7'],
                loadBalancing: {
                  strategy: 'weighted',
                  weights: {
                    'mini27.MiniMax-M2.7': 1,
                    'minimonth.MiniMax-M2.7': 1
                  }
                }
              }
            ],
            default: [
              {
                id: 'gateway-priority-5555-default',
                mode: 'priority',
                targets: ['mini27.MiniMax-M2.7', 'minimonth.MiniMax-M2.7']
              }
            ]
          }
        }
      }
    }
  };
}

function buildServerConfig(configPath: string): ServerConfigV2 {
  return {
    configPath,
    server: { host: '127.0.0.1', port: 0 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  } as ServerConfigV2;
}

describe('router-mode relay recoverable busy blackbox', () => {
  jest.setTimeout(30000);

  it('returns HTTP 429 after executor retries instead of PROVIDER_NOT_AVAILABLE when relay route pool is busy', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-relay-busy-'));
    const configPath = path.join(tmp, 'config.json');
    const userConfig = buildUserConfig();
    await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2), 'utf8');
    const restores = [
      setEnv('NODE_ENV', 'test'),
      setEnv('ROUTECODEX_SNAPSHOT', '0'),
      setEnv('RCC_429_BACKOFF_BASE_MS', '1'),
      setEnv('RCC_429_BACKOFF_MAX_MS', '8'),
      setEnv('ROUTECODEX_AUTH_DIR', path.join(tmp, 'auth')),
      setEnv('ROUTECODEX_STATS_LOG', path.join(tmp, 'stats.json')),
      setEnv('ROUTECODEX_LOGIN_FILE', path.join(tmp, 'login'))
    ];
    const server = new RouteCodexHttpServer(buildServerConfig(configPath));
    const logStages: Array<{ stage: string; details: Record<string, unknown> }> = [];
    (server as any).logStage = (stage: string, _requestId: string, details: Record<string, unknown>) => {
      logStages.push({ stage, details });
    };
    try {
      await server.initializeWithUserConfig(userConfig as any);
      await server.start();
      const raw = (server as unknown as { server?: http.Server }).server;
      const address = raw?.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') throw new Error('test server did not bind');
      const pipeline = (server as any).resolveHubPipelineForRoutingPolicyGroup('gateway_priority_5555');
      pipeline.getVirtualRouter().markConcurrencyScopeBusy('mini27.key1.MiniMax-M2.7');
      pipeline.getVirtualRouter().markConcurrencyScopeBusy('minimonth.key1.MiniMax-M2.7');

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'Search once, then answer ping.',
          stream: false,
          tools: [{ type: 'web_search_preview' }],
          metadata: { routeHint: 'search', sessionId: 'router-relay-busy-blackbox' }
        })
      });
      const body = await response.json();
      expect(response.status).toBe(429);
      expect(body.error?.code).toBe('HTTP_429');
      expect(body.error?.code).not.toBe('PROVIDER_NOT_AVAILABLE');
      expect(logStages.filter((entry) => entry.stage === 'provider.route_pool_cooldown_wait')).toHaveLength(3);
      expect(logStages.some((entry) => entry.stage === 'router-direct.hub_pipeline_failed')).toBe(false);
    } finally {
      await server.stop().catch(() => undefined);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
