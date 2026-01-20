import { jest } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const BRIDGE_MODULE_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge.ts');

describe('RouteCodexHttpServer quotaView injection', () => {
  let tempConfigPath = '';
  const originalSnapshot = process.env.ROUTECODEX_SNAPSHOT;
  const originalEngineEnable = process.env.ROUTECODEX_LLMS_ENGINE_ENABLE;
  const originalShadowPrefixes = process.env.ROUTECODEX_LLMS_SHADOW_PREFIXES;
  const originalShadowSampleRate = process.env.ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE;

  afterEach(async () => {
    if (originalSnapshot === undefined) delete process.env.ROUTECODEX_SNAPSHOT;
    else process.env.ROUTECODEX_SNAPSHOT = originalSnapshot;

    if (originalEngineEnable === undefined) delete process.env.ROUTECODEX_LLMS_ENGINE_ENABLE;
    else process.env.ROUTECODEX_LLMS_ENGINE_ENABLE = originalEngineEnable;

    if (originalShadowPrefixes === undefined) delete process.env.ROUTECODEX_LLMS_SHADOW_PREFIXES;
    else process.env.ROUTECODEX_LLMS_SHADOW_PREFIXES = originalShadowPrefixes;

    if (originalShadowSampleRate === undefined) delete process.env.ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE;
    else process.env.ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE = originalShadowSampleRate;

    if (tempConfigPath) {
      try {
        await fs.rm(path.dirname(tempConfigPath), { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      tempConfigPath = '';
    }
  });

  async function createTempUserConfig(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-inject-'));
    const filePath = path.join(dir, 'config.json');
    const config = {
      virtualrouterMode: 'v1',
      virtualrouter: {
        providers: {
          mock: {
            type: 'mock',
            endpoint: 'mock://',
            auth: { type: 'apiKey', value: 'dummy_dummy_dummy' },
            models: { dummy: {} }
          }
        },
        routing: { default: ['mock.dummy'] }
      }
    };
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
    return filePath;
  }

  it('injects quotaView into HubPipeline config by default', async () => {
    tempConfigPath = await createTempUserConfig();

    const captured: { quotaView?: unknown; quotaViewReadOnly?: unknown } = {};
    const quotaView = () => null;

    jest.resetModules();
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
      extractSessionIdentifiersFromMetadata: () => ({}),
      loadRoutingInstructionStateSync: () => null,
      saveRoutingInstructionStateAsync: () => {},
      getProviderErrorCenter: async () => ({
        emit: () => {},
        subscribe: () => () => {}
      }),
      bootstrapVirtualRouterConfig: async (input: any) => ({ config: input, targetRuntime: {} }),
      convertProviderResponse: async (value: any) => value,
      createSnapshotRecorder: () => ({}) as any,
      rebindResponsesConversationRequestId: async () => {},
      resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
      writeSnapshotViaHooks: async () => {},
      buildResponsesRequestFromChat: async () => ({}),
      ensureResponsesInstructions: async () => {},
      createResponsesSseToJsonConverter: async () => ({
        convertSseToJson: async () => ({})
      }),
      getHubPipelineCtor: async () =>
        class HubPipelineMock {
          constructor(config: any) {
            captured.quotaView = config?.quotaView;
            captured.quotaViewReadOnly = config?.quotaViewReadOnly;
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: {}
            };
          }
        },
      getHubPipelineCtorForImpl: async () =>
        class HubPipelineMock {
          constructor(config: any) {
            captured.quotaView = config?.quotaView;
            captured.quotaViewReadOnly = config?.quotaViewReadOnly;
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: {}
            };
          }
        }
    }));

    const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');

    const config: any = {
      configPath: tempConfigPath,
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    };

    const server = new RouteCodexHttpServer(config);
    (server as any).managerDaemon = {
      getModule: (id: string) => (id === 'provider-quota' ? { getQuotaView: () => quotaView } : undefined)
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    expect(typeof captured.quotaView).toBe('function');
    expect(captured.quotaView).toBe(quotaView);
    expect(captured.quotaViewReadOnly).toBeUndefined();
  });

  it('does not inject quotaView when server quotaRoutingEnabled is false', async () => {
    tempConfigPath = await createTempUserConfig();

    const captured: { quotaView?: unknown; quotaViewReadOnly?: unknown } = {};
    const quotaView = () => null;

    jest.resetModules();
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
      extractSessionIdentifiersFromMetadata: () => ({}),
      loadRoutingInstructionStateSync: () => null,
      saveRoutingInstructionStateAsync: () => {},
      getProviderErrorCenter: async () => ({
        emit: () => {},
        subscribe: () => () => {}
      }),
      bootstrapVirtualRouterConfig: async (input: any) => ({ config: input, targetRuntime: {} }),
      convertProviderResponse: async (value: any) => value,
      createSnapshotRecorder: () => ({}) as any,
      rebindResponsesConversationRequestId: async () => {},
      resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
      writeSnapshotViaHooks: async () => {},
      buildResponsesRequestFromChat: async () => ({}),
      ensureResponsesInstructions: async () => {},
      createResponsesSseToJsonConverter: async () => ({
        convertSseToJson: async () => ({})
      }),
      getHubPipelineCtor: async () =>
        class HubPipelineMock {
          constructor(config: any) {
            captured.quotaView = config?.quotaView;
            captured.quotaViewReadOnly = config?.quotaViewReadOnly;
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: {}
            };
          }
        },
      getHubPipelineCtorForImpl: async () =>
        class HubPipelineMock {
          constructor(config: any) {
            captured.quotaView = config?.quotaView;
            captured.quotaViewReadOnly = config?.quotaViewReadOnly;
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: {}
            };
          }
        }
    }));

    const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');

    const config: any = {
      configPath: tempConfigPath,
      server: { host: '127.0.0.1', port: 0, quotaRoutingEnabled: false },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    };

    const server = new RouteCodexHttpServer(config);
    (server as any).managerDaemon = {
      getModule: (id: string) => (id === 'provider-quota' ? { getQuotaView: () => quotaView } : undefined)
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    expect(captured.quotaView).toBeUndefined();
    expect(captured.quotaViewReadOnly).toBeUndefined();
  });

  it('uses quotaViewReadOnly for llms-engine shadow pipeline to avoid double side effects', async () => {
    tempConfigPath = await createTempUserConfig();

    process.env.ROUTECODEX_SNAPSHOT = '0';
    process.env.ROUTECODEX_LLMS_ENGINE_ENABLE = '1';
    process.env.ROUTECODEX_LLMS_SHADOW_PREFIXES = 'conversion/hub/pipeline';
    process.env.ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE = '1';

    const captured: { engineQuotaView?: unknown } = {};
    const quotaView = () => null;
    const quotaViewReadOnly = () => null;

    jest.resetModules();
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
      extractSessionIdentifiersFromMetadata: () => ({}),
      loadRoutingInstructionStateSync: () => null,
      saveRoutingInstructionStateAsync: () => {},
      getProviderErrorCenter: async () => ({
        emit: () => {},
        subscribe: () => () => {}
      }),
      bootstrapVirtualRouterConfig: async (input: any) => ({ config: input, targetRuntime: {} }),
      convertProviderResponse: async (value: any) => value,
      createSnapshotRecorder: () => ({}) as any,
      rebindResponsesConversationRequestId: async () => {},
      resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
      writeSnapshotViaHooks: async () => {},
      buildResponsesRequestFromChat: async () => ({}),
      ensureResponsesInstructions: async () => {},
      createResponsesSseToJsonConverter: async () => ({
        convertSseToJson: async () => ({})
      }),
      getHubPipelineCtor: async () =>
        class HubPipelineMock {
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              requestId: 'req_shadow_test',
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: { processMode: 'chat', providerProtocol: 'chat', stream: false, entryEndpoint: '/v1/chat/completions' }
            };
          }
        },
      getHubPipelineCtorForImpl: async () =>
        class HubPipelineEngineMock {
          constructor(config: any) {
            captured.engineQuotaView = config?.quotaView;
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return {
              requestId: 'req_shadow_test__engine',
              providerPayload: { ok: true },
              target: { providerKey: 'mock.dummy' },
              metadata: { processMode: 'chat', providerProtocol: 'chat', stream: false, entryEndpoint: '/v1/chat/completions' }
            };
          }
        }
    }));

    const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');

    const config: any = {
      configPath: tempConfigPath,
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    };

    const server = new RouteCodexHttpServer(config);
    (server as any).managerDaemon = {
      getModule: (id: string) =>
        id === 'provider-quota'
          ? {
              getQuotaView: () => quotaView,
              getQuotaViewReadOnly: () => quotaViewReadOnly
            }
          : undefined
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    await (server as any).ensureHubPipelineEngineShadow();

    expect(captured.engineQuotaView).toBe(quotaViewReadOnly);
  });
});
