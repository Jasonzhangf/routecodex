import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { registerDefaultMiddleware } from '../../../src/server/runtime/http-server/middleware.js';
import { registerHttpRoutes } from '../../../src/server/runtime/http-server/routes.js';

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function readModelsPayload(body: any): any[] {
  expect(Array.isArray(body?.models)).toBe(true);
  expect(Array.isArray(body?.data)).toBe(true);
  expect(body.models).toEqual(body.data);
  return body.models;
}

describe('models route port scoping', () => {
  it('shows only current port models and uses alias when configured', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-port-scoped-'));
    const providerRoot = path.join(tmp, 'provider');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(path.join(providerRoot, 'DF'), { recursive: true });
    await fs.writeFile(
      path.join(providerRoot, 'DF', 'config.v2.toml'),
      `version = "2.0.0"\nproviderId = "DF"\n\n[provider]\nid = "DF"\nenabled = true\ntype = "openai"\nbaseURL = "https://www.dreamfield.top/v1"\n\n[provider.auth]\ntype = "apikey"\napiKey = "test"\n\n[provider.models."demo-v4-pro"]\nsupportsStreaming = true\naliases = ["demo-v4-pro"]\n\n[provider.models."demo-v4-flash"]\nsupportsStreaming = true\n`,
      'utf8'
    );
    const app = express();
    registerDefaultMiddleware(app, { server: { port: 10000, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 10000, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {},
      getPortConfigs: () => [{ port: 10000, routingPolicyGroup: 'gateway_coding_10000' }],
      getUserConfig: () => ({
        virtualrouter: {
          routingPolicyGroups: {
            gateway_coding_10000: {
              routing: {
                coding: [{ targets: ['DF.demo-v4-pro'] }],
                tools: [{ targets: ['DF.demo-v4-flash'] }]
              }
            }
          }
        }
      })
    } as any);
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const body = await response.json();
        const models = readModelsPayload(body);
        const ids = models.map((x: any) => x.id).sort();
        expect(ids).toEqual(['demo-v4-flash', 'demo-v4-pro', 'gpt-5.5']);
        expect(models.find((x: any) => x.id === 'demo-v4-pro').owned_by).toBe('DF');
        expect(models.find((x: any) => x.id === 'demo-v4-flash').owned_by).toBe('DF');
      });
    } finally {
      if (restoreRccHome === undefined) delete process.env.RCC_HOME; else process.env.RCC_HOME = restoreRccHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
