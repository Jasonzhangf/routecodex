import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { jest } from '@jest/globals';

export type TestMocks = {
  updateProviderModels: jest.Mock<any>;
  fetchModelsFromUpstream: jest.Mock<any>;
  readBlacklist: jest.Mock<any>;
  writeBlacklist: jest.Mock<any>;
  probeContextForModel: jest.Mock<any>;
  runVercelAiProviderDoctor: jest.Mock<any>;
  getProviderTemplates: jest.Mock<any>;
  pickProviderTemplate: jest.Mock<any>;
  buildProviderFromTemplate: jest.Mock<any>;
  inspectProviderConfig: jest.Mock<any>;
  buildRoutingHintsConfigFragment: jest.Mock<any>;
  loadProviderConfigsV2: jest.Mock<any>;
  resolveRccProviderDir: jest.Mock<any>;
  loadRouteCodexConfig: jest.Mock<any>;
};

const makeReadlineInterface = (answers: string[]) => ({
  question: (_prompt: string, cb: (answer: string) => void) => cb(answers.shift() ?? ''),
  close: () => {}
});

export async function loadProviderCommand(): Promise<{
  createProviderUpdateCommand: () => import('commander').Command;
  mocks: TestMocks;
  answers: string[];
}> {
  jest.resetModules();

  const answers: string[] = [];
  const template = {
    id: 'openai',
    label: 'OpenAI',
    source: 'bootstrap-generic',
    defaultBaseUrl: 'https://api.example.com/v1',
    defaultAuthType: 'apikey',
    defaultModel: 'gpt-4.1-mini',
    providerTypeHint: 'openai'
  };

  const mocks: TestMocks = {
    updateProviderModels: jest.fn(async () => ({
      providerId: 'demo',
      totalRemote: 3,
      filtered: 2,
      outputPath: '/tmp/provider/demo/config.v2.json',
      blacklistPath: '/tmp/provider/demo/blacklist.json'
    })),
    fetchModelsFromUpstream: jest.fn(async () => ({
      models: ['model-a', 'model-b'],
      raw: { ok: true }
    })),
    readBlacklist: jest.fn(() => ({ models: [] })),
    writeBlacklist: jest.fn(),
    probeContextForModel: jest.fn(async (_modelId: string) => ({
      maxPassedTokens: 256000
    })),
    runVercelAiProviderDoctor: jest.fn(async () => ({
      ok: true,
      message: 'ok',
      text: 'OK',
      baseURL: 'https://api.example.com/v1',
      binding: { family: 'openai', supported: true }
    })),
    getProviderTemplates: jest.fn(() => [template]),
    pickProviderTemplate: jest.fn(() => template),
    buildProviderFromTemplate: jest.fn(
      (
        providerId: string,
        _tpl: Record<string, unknown>,
        baseUrl: string,
        authType: string,
        apiKeyPlaceholder: string,
        tokenFile: string,
        modelId: string,
        extra?: { additionalModelIds?: string[]; defaultModelId?: string }
      ) => {
        const models = [modelId, ...(extra?.additionalModelIds ?? [])];
        return {
          type: providerId,
          baseURL: baseUrl,
          auth: authType.includes('apikey')
            ? { type: authType, apiKey: apiKeyPlaceholder || 'YOUR_API_KEY_HERE' }
            : { type: authType, tokenFile: tokenFile || '~/.rcc/auth/oauth.json' },
          models: Object.fromEntries(models.map((id) => [id, { supportsStreaming: true }])),
          defaultModel: extra?.defaultModelId || modelId
        };
      }
    ),
    inspectProviderConfig: jest.fn(() => ({
      providerId: 'demo',
      version: '2.0.0',
      providerType: 'openai',
      baseURL: 'https://api.example.com/v1',
      authType: 'apikey',
      compatibilityProfile: 'responses:v1',
      catalogId: 'openai',
      catalogLabel: 'OpenAI',
      defaultModel: 'gpt-4.1-mini',
      routeTargets: { default: 'default', webSearch: 'web_search' },
      modelCount: 2,
      models: ['gpt-4.1-mini', 'gpt-5.2-codex'],
      sdkBinding: { family: 'openai' },
      capabilities: { chat: true },
      webSearch: { enabled: true },
      routingHints: { provider: 'demo', route: 'default' }
    })),
    buildRoutingHintsConfigFragment: jest.fn(() => ({ providers: [{ id: 'demo' }] })),
    loadProviderConfigsV2: jest.fn(async () => ({})),
    resolveRccProviderDir: jest.fn(() => '/tmp/provider-root-default'),
    loadRouteCodexConfig: jest.fn(async () => ({
      configPath: '/tmp/provider-root-default/config.json',
      userConfig: {
        virtualrouter: {
          routing: {
            multimodal: [{ id: 'mm', targets: ['demo.qwen3.5-plus'] }],
            vision: [{ id: 'vs', targets: ['demo.qwen3.5-plus'] }]
          }
        }
      },
      providerProfiles: { profiles: [], byId: {} }
    }))
  };

  await jest.unstable_mockModule('node:readline', () => ({
    default: {
      createInterface: () => makeReadlineInterface(answers)
    },
    createInterface: () => makeReadlineInterface(answers)
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/index.js', () => ({
    updateProviderModels: mocks.updateProviderModels
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/fetch-models.js', () => ({
    fetchModelsFromUpstream: mocks.fetchModelsFromUpstream
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/blacklist.js', () => ({
    readBlacklist: mocks.readBlacklist,
    writeBlacklist: mocks.writeBlacklist
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/probe-context.js', () => ({
    probeContextForModel: mocks.probeContextForModel
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/vercel-ai-doctor.js', () => ({
    runVercelAiProviderDoctor: mocks.runVercelAiProviderDoctor
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/provider-add-template.js', () => ({
    getProviderTemplates: mocks.getProviderTemplates,
    pickProviderTemplate: mocks.pickProviderTemplate,
    buildProviderFromTemplate: mocks.buildProviderFromTemplate
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/provider-inspect.js', () => ({
    inspectProviderConfig: mocks.inspectProviderConfig,
    buildRoutingHintsConfigFragment: mocks.buildRoutingHintsConfigFragment
  }));
  await jest.unstable_mockModule('../../src/config/provider-v2-loader.js', () => ({
    loadProviderConfigsV2: mocks.loadProviderConfigsV2
  }));
  await jest.unstable_mockModule('../../src/config/user-data-paths.js', () => ({
    resolveRccProviderDir: mocks.resolveRccProviderDir
  }));
  await jest.unstable_mockModule('../../src/config/routecodex-config-loader.js', () => ({
    loadRouteCodexConfig: mocks.loadRouteCodexConfig
  }));

  const mod = await import('../../src/commands/provider-update.js');
  return { createProviderUpdateCommand: mod.createProviderUpdateCommand, mocks, answers };
}

export const swallowConsole = () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  return { log, error, warn };
};

export const mockProcessExit = () =>
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code ?? 0)}`);
  }) as never);

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
