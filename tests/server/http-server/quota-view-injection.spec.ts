import { jest } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const BRIDGE_MODULE_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge.ts');

describe('RouteCodexHttpServer quotaView injection', () => {
  const originalQuotaFlag = process.env.ROUTECODEX_QUOTA_ENABLED;
  let tempConfigPath = '';

  afterEach(async () => {
    if (originalQuotaFlag === undefined) {
      delete process.env.ROUTECODEX_QUOTA_ENABLED;
    } else {
      process.env.ROUTECODEX_QUOTA_ENABLED = originalQuotaFlag;
    }
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
    delete process.env.ROUTECODEX_QUOTA_ENABLED;
    tempConfigPath = await createTempUserConfig();

    const captured: { quotaView?: unknown } = {};
    const quotaView = () => null;

    jest.resetModules();
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
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
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return { metadata: {} };
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
  });

  it('does not inject quotaView when ROUTECODEX_QUOTA_ENABLED disables it', async () => {
    process.env.ROUTECODEX_QUOTA_ENABLED = '0';
    tempConfigPath = await createTempUserConfig();

    const captured: { quotaView?: unknown } = {};
    const quotaView = () => null;

    jest.resetModules();
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
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
          }
          updateVirtualRouterConfig(): void {}
          async execute(): Promise<any> {
            return { metadata: {} };
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

    expect(captured.quotaView).toBeUndefined();
  });
});
