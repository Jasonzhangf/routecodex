import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.sort();
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for condition');
}

describe('Unified Hub runtime shadow compare → errorsamples', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('writes an errorsample only when diff exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-shadow-runtime-'));
    const errorsRoot = path.join(tmp, 'errorsamples');
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsRoot;

    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE = '1';
    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_BASELINE_MODE = 'off';
    process.env.ROUTECODEX_UNIFIED_HUB_SHADOW_COMPARE_SAMPLE_RATE = '1';

    const { RouteCodexHttpServer } = await import('../../src/server/runtime/http-server/index.js');

    const server: any = new RouteCodexHttpServer({
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    });

    class HubPipelineMock {
      async execute(input: any): Promise<any> {
        const override = input?.metadata?.__hubPolicyOverride;
        const isBaseline = Boolean(override) && override.mode === 'off';
        const providerPayload = isBaseline
          ? { model: 'x', input: [{ role: 'user', content: 'hi' }], __shadow_test: 1 }
          : { model: 'x', input: [{ role: 'user', content: 'hi' }] };
        return {
          providerPayload,
          target: { providerKey: 'mock.key1.mock-model', providerType: 'mock-provider', outboundProfile: 'openai-responses' },
          routingDecision: { routeName: 'default' },
          metadata: {
            entryEndpoint: input?.endpoint || '/v1/responses',
            providerProtocol: 'openai-responses',
            processMode: 'chat',
            stream: false,
            routeHint: 'default'
          }
        };
      }
      updateVirtualRouterConfig(): void {}
    }

    server.hubPipeline = new HubPipelineMock();
    server.hubShadowComparePipeline = new HubPipelineMock();

    await server.runHubPipeline(
      {
        entryEndpoint: '/v1/responses',
        method: 'POST',
        requestId: 'req_shadow_runtime_test',
        headers: {},
        query: {},
        body: { model: 'x', input: [{ role: 'user', content: 'hi' }], __shadow_test: 1 },
        metadata: {}
      },
      { routeHint: 'default' }
    );

    const dir = path.join(errorsRoot, 'unified-hub-shadow-runtime');
    await waitFor(async () => (await listFiles(dir)).length > 0, 3000);

    const files = await listFiles(dir);
    expect(files.some((f) => f.includes('diff-') && f.endsWith('.json'))).toBe(true);
  });
});

