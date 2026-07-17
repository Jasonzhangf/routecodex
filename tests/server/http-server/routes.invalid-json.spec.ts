import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { registerDefaultMiddleware } from '../../../src/server/runtime/http-server/middleware.js';
import { registerHttpRoutes } from '../../../src/server/runtime/http-server/routes.js';
import { serializeTomlRecord } from '../../../src/config/toml-basic.js';
import { initializeRouteErrorHub } from '../../../src/error-handling/route-error-hub.js';

// Canonical builder trace for server.models_capability_contract:
// buildCodexModelMetadata / buildBuiltinCodexModelMetadata / collectConfiguredModelItems

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

function expectGpt55CodexContract(model: any): void {
  expect(model).toMatchObject({
    apply_patch_tool_type: 'freeform',
    default_reasoning_level: 'medium',
    default_reasoning_summary: 'none',
    default_verbosity: 'low',
    description: 'Frontier model for complex coding, research, and real-world work.',
    effective_context_window_percent: 95,
    experimental_supported_tools: ['apply_patch', 'web_search'],
    input_modalities: ['text', 'image'],
    minimal_client_version: '0.124.0',
    prefer_websockets: false,
    reasoning_summary_format: 'experimental',
    shell_type: 'shell_command',
    support_verbosity: true,
    supported_in_api: true,
    supports_image_detail_original: true,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    supports_search_tool: true,
    visibility: 'list',
    web_search_tool_type: 'text_and_image'
  });
  expect(model.supported_reasoning_levels).toEqual([
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
  ]);
}

function expectGpt56CodexContract(
  model: any,
  expected: { description: string; defaultReasoningLevel: string; includesUltra: boolean }
): void {
  expect(model).toMatchObject({
    apply_patch_tool_type: 'freeform',
    default_reasoning_level: expected.defaultReasoningLevel,
    default_reasoning_summary: 'none',
    default_verbosity: 'low',
    description: expected.description,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    minimal_client_version: '0.144.0',
    prefer_websockets: false,
    shell_type: 'shell_command',
    support_verbosity: true,
    supported_in_api: true,
    supports_image_detail_original: true,
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    visibility: 'list',
    web_search_tool_type: 'text_and_image'
  });
  expect(model.context_window).toBe(372000);
  expect(model.max_context_window).toBe(372000);
  expect(model.supported_reasoning_levels.map((entry: any) => entry.effort)).toEqual(
    expected.includesUltra
      ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      : ['low', 'medium', 'high', 'xhigh', 'max']
  );
}

function readModelsPayload(body: any): any[] {
  expect(Array.isArray(body?.models)).toBe(true);
  expect(Array.isArray(body?.data)).toBe(true);
  expect(body.models).toEqual(body.data);
  return body.models;
}

describe('http routes invalid json handling', () => {
  beforeAll(() => {
    initializeRouteErrorHub({
      errorHandlingCenter: {
        async initialize() {},
        async handleError() {},
      } as never
    });
  });

  it('returns structured json instead of express html stack for malformed json bodies', async () => {
    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"demo-web.demo-chat","input":"bad\\escape"}'
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type') || '').toContain('application/json');
      const body = await response.json();
      expect(body?.error?.message).toContain('Bad escaped character');
      expect(body?.error?.code).toBe('MALFORMED_REQUEST');
    });
  });

  it('exposes context_window for provider-prefixed models from provider v2 configs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-context-window-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'demo-web');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      `${serializeTomlRecord(
        {
          version: '2.0.0',
          providerId: 'demo-web',
          provider: {
            id: 'demo-web',
            enabled: true,
            type: 'openai',
            baseURL: 'https://chat.example.com',
            models: {
              'demo-reasoner': {
                supportsStreaming: true,
                maxContext: 750000,
                maxContextTokens: 750000
              }
            }
          }
        }
      )}\n`,
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const body = await response.json();
        const target = readModelsPayload(body).find((item: any) => item?.id === 'demo-web.demo-reasoner');
        expect(target).toBeTruthy();
        expect(target.context_window).toBe(750000);
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('exposes Codex advanced model metadata so clients enable apply_patch capabilities', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-codex-metadata-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'minimax');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      `${serializeTomlRecord(
        {
          version: '2.0.0',
          providerId: 'minimax',
          provider: {
            id: 'minimax',
            enabled: true,
            type: 'openai',
            baseURL: 'https://api.minimax.io',
            models: {
              'MiniMax-M3': {
                supportsStreaming: true,
                maxContext: 1000000
              },
              'gpt-5.5': {
                supportsStreaming: true,
                maxContext: 1000000
              }
            }
          }
        }
      )}\n`,
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const body = await response.json();
        const data = readModelsPayload(body);
        const bareAdvanced = data.find((item: any) => item?.id === 'gpt-5.5');
        const sol = data.find((item: any) => item?.id === 'gpt-5.6-sol');
        const terra = data.find((item: any) => item?.id === 'gpt-5.6-terra');
        const luna = data.find((item: any) => item?.id === 'gpt-5.6-luna');
        const minimax = data.find((item: any) => item?.id === 'minimax.MiniMax-M3');
        const advanced = data.find((item: any) => item?.id === 'minimax.gpt-5.5');
        expect(bareAdvanced).toBeTruthy();
        expect(sol).toBeTruthy();
        expect(terra).toBeTruthy();
        expect(luna).toBeTruthy();
        expect(minimax).toBeTruthy();
        expect(advanced).toBeTruthy();
        expectGpt55CodexContract(bareAdvanced);
        expectGpt56CodexContract(sol, {
          description: 'Latest frontier agentic coding model.',
          defaultReasoningLevel: 'low',
          includesUltra: true
        });
        expectGpt56CodexContract(terra, {
          description: 'Balanced agentic coding model for everyday work.',
          defaultReasoningLevel: 'medium',
          includesUltra: true
        });
        expectGpt56CodexContract(luna, {
          description: 'Fast and affordable agentic coding model.',
          defaultReasoningLevel: 'medium',
          includesUltra: false
        });
        expect(bareAdvanced.owned_by).toBe('openai');
        expect(sol.owned_by).toBe('openai');
        expect(terra.owned_by).toBe('openai');
        expect(luna.owned_by).toBe('openai');
        expect(bareAdvanced.context_window).toBe(272000);
        expect(bareAdvanced.max_context_window).toBe(272000);
        expect(minimax.apply_patch_tool_type).toBe('freeform');
        expect(advanced.apply_patch_tool_type).toBe('freeform');
        expect(minimax.apply_patch_tool_type).not.toBe('schema');
        expect(minimax.web_search_tool_type).toBe('text_and_image');
        expect(minimax.supports_search_tool).toBe(true);
        expect(minimax.supports_parallel_tool_calls).toBe(true);
        expect(minimax.input_modalities).toEqual(['text', 'image']);
        expect(minimax.context_window).toBe(1000000);
        expect(minimax.max_context_window).toBe(1000000);
        expectGpt55CodexContract(advanced);
        expect(advanced.context_window).toBe(1000000);
        expect(advanced.max_context_window).toBe(1000000);
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('projects /v1/models instead of raw provider.models while keeping gpt and deep v4 pro visible', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-visible-filter-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'demo-web');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      `${serializeTomlRecord(
        {
          version: '2.0.0',
          providerId: 'demo-web',
          provider: {
            id: 'demo-web',
            enabled: true,
            type: 'openai',
            baseURL: 'https://chat.example.com',
            models: {
              'demo-v4-pro': { supportsStreaming: true },
              'demo-v4-flash': { supportsStreaming: true },
              'gpt-5.5': { supportsStreaming: true }
            }
          }
        }
      )}\n`,
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const body = await response.json();
        const ids = readModelsPayload(body).map((item: any) => item?.id).filter(Boolean);
        expect(ids).toContain('gpt-5.5');
        expect(ids).toContain('demo-web.demo-v4-pro');
        expect(ids).toContain('demo-web.demo-v4-flash');
        expect(ids).not.toEqual(expect.arrayContaining(['demo-v4-pro', 'demo-v4-flash', 'gpt-5.5']));
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lists only the current port models and uses alias when configured', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-port-scoped-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'DF');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "DF"',
        '',
        '[provider]',
        'id = "DF"',
        'enabled = true',
        'type = "openai"',
        'baseURL = "https://www.dreamfield.top/v1"',
        '',
        '[provider.auth]',
        'type = "apikey"',
        'entries = [',
        '  { alias = "key1", apiKey = "test" }',
        ']',
        '',
        '[provider.models."DeepSeek-V4-Pro"]',
        'supportsStreaming = true',
        'aliases = ["demo-v4-pro"]',
        '',
        '[provider.models."DeepSeek-V4-Flash"]',
        'supportsStreaming = true'
      ].join('\n'),
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
                coding: [{ targets: ['DF.key1.demo-v4-pro'] }],
                tools: [{ targets: ['DF.key1.demo-v4-flash'] }]
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
        const ids = readModelsPayload(body).map((item: any) => item.id).sort();
        expect(ids).toContain('demo-v4-pro');
        expect(ids).toContain('demo-v4-flash');
        expect(ids).not.toContain('gpt-5.5');
        expect(ids).not.toContain('gpt-5.6-sol');
        expect(ids).not.toContain('gpt-5.6-terra');
        expect(ids).not.toContain('gpt-5.6-luna');
        expect(ids).not.toContain('DF.demo-v4-pro');
        expect(ids).not.toContain('DF.demo-v4-flash');
        expect(ids).not.toContain('DeepSeek-V4-Pro');
        expect(ids).not.toContain('DeepSeek-V4-Flash');
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('uses the current port routing models to decide which built-in Codex capabilities are visible', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-port-codex-family-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'cc');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "cc"',
        '',
        '[provider]',
        'id = "cc"',
        'enabled = true',
        'type = "responses"',
        'baseURL = "https://api.example.com/v1"',
        '',
        '[provider.auth]',
        'type = "apikey"',
        'entries = [',
        '  { alias = "key1", apiKey = "test" }',
        ']',
        '',
        '[provider.models."gpt-5.5"]',
        'supportsStreaming = true',
        '',
        '[provider.models."gpt-5.6-sol"]',
        'supportsStreaming = true'
      ].join('\n'),
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {},
      getPortConfigs: () => [{ port: 5520, routingPolicyGroup: 'gateway_priority_5520' }],
      getUserConfig: () => ({
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [{ targets: ['cc.key1.gpt-5.5'] }]
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
        const data = readModelsPayload(await response.json());
        const ids = data.map((item: any) => item.id).sort();
        expect(ids).toContain('gpt-5.5');
        expect(ids).not.toContain('gpt-5.6-sol');
        expect(ids).not.toContain('gpt-5.6-terra');
        expect(ids).not.toContain('gpt-5.6-luna');
        const gpt55 = data.find((item: any) => item.id === 'gpt-5.5');
        expectGpt55CodexContract(gpt55);
        expect(gpt55.use_responses_lite).toBeUndefined();
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps gpt-5.6 lite metadata visible when the current port routes to a gpt-5.6 model', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-port-codex-56-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'cc-sol');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "cc-sol"',
        '',
        '[provider]',
        'id = "cc-sol"',
        'enabled = true',
        'type = "responses"',
        'baseURL = "https://api.example.com/v1"',
        '',
        '[provider.auth]',
        'type = "apikey"',
        'entries = [',
        '  { alias = "key1", apiKey = "test" }',
        ']',
        '',
        '[provider.models."gpt-5.6-sol"]',
        'supportsStreaming = true'
      ].join('\n'),
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {},
      getPortConfigs: () => [{ port: 5520, routingPolicyGroup: 'gateway_priority_5520' }],
      getUserConfig: () => ({
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [{ targets: ['cc-sol.key1.gpt-5.6-sol'] }]
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
        const data = readModelsPayload(await response.json());
        const ids = data.map((item: any) => item.id).sort();
        expect(ids).toContain('gpt-5.6-sol');
        expect(ids).not.toContain('gpt-5.5');
        expect(ids).not.toContain('gpt-5.6-terra');
        expect(ids).not.toContain('gpt-5.6-luna');
        const sol = data.find((item: any) => item.id === 'gpt-5.6-sol');
        expectGpt56CodexContract(sol, {
          description: 'Latest frontier agentic coding model.',
          defaultReasoningLevel: 'low',
          includesUltra: true
        });
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('uses compiled virtual router status as the live route-surface truth when available', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-runtime-status-'));
    const providerRoot = path.join(tmp, 'provider');
    const ccDir = path.join(providerRoot, 'cc');
    const solDir = path.join(providerRoot, 'cc-sol');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(ccDir, { recursive: true });
    await fs.mkdir(solDir, { recursive: true });
    await fs.writeFile(
      path.join(ccDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "cc"',
        '',
        '[provider]',
        'id = "cc"',
        'enabled = true',
        'type = "responses"',
        'baseURL = "https://api.example.com/v1"',
        '',
        '[provider.models."gpt-5.5"]',
        'supportsStreaming = true'
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(solDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "cc-sol"',
        '',
        '[provider]',
        'id = "cc-sol"',
        'enabled = true',
        'type = "responses"',
        'baseURL = "https://api.example.com/v1"',
        '',
        '[provider.models."gpt-5.6-sol"]',
        'supportsStreaming = true'
      ].join('\n'),
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {},
      getPortConfigs: () => [{ port: 5520, routingPolicyGroup: 'gateway_priority_5520' }],
      getUserConfig: () => ({
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [{ targets: ['cc.key1.gpt-5.6-terra'] }]
              }
            }
          }
        }
      }),
      getHubPipeline: () => ({
        virtualRouter: {
          getStatus: () => ({
            routes: {
              'gateway_priority_5520:default': {
                pools: [
                  {
                    resolvedForwarders: [
                      {
                        modelId: 'gpt-5.5',
                        targetProviderKeys: ['cc.key1.gpt-5.5']
                      }
                    ]
                  }
                ]
              },
              'gateway_priority_5520:thinking': {
                pools: [
                  {
                    resolvedForwarders: [
                      {
                        modelId: 'gpt-5.6-sol',
                        targetProviderKeys: ['cc-sol.key1.gpt-5.6-sol']
                      }
                    ]
                  }
                ]
              }
            }
          })
        }
      })
    } as any);

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const data = readModelsPayload(await response.json());
        const ids = data.map((item: any) => item.id).sort();
        expect(ids).toEqual(['gpt-5.5', 'gpt-5.6-sol']);
        expectGpt55CodexContract(data.find((item: any) => item.id === 'gpt-5.5'));
        expectGpt56CodexContract(data.find((item: any) => item.id === 'gpt-5.6-sol'), {
          description: 'Latest frontier agentic coding model.',
          defaultReasoningLevel: 'low',
          includesUltra: true
        });
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
