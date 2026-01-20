import { jest } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const BRIDGE_MODULE_PATH = path.resolve(process.cwd(), 'src/modules/llmswitch/bridge.ts');

describe('RouteCodexHttpServer hub policy injection', () => {
  let tempConfigPath = '';

  afterEach(async () => {
    delete process.env.ROUTECODEX_HUB_POLICY_MODE;
    delete process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE;
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-hub-policy-'));
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

  it('injects hubConfig.policy when ROUTECODEX_HUB_POLICY_MODE=observe', async () => {
    process.env.ROUTECODEX_HUB_POLICY_MODE = 'observe';
    process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE = '0.25';

    tempConfigPath = await createTempUserConfig();

    const captured: { policy?: unknown } = {};

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
            captured.policy = config?.policy;
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
      getModule: () => undefined
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    expect(captured.policy).toEqual({ mode: 'observe', sampleRate: 0.25 });
  });

  it('injects hubConfig.policy by default (enforce)', async () => {
    tempConfigPath = await createTempUserConfig();

    const captured: { policy?: unknown } = {};

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
            captured.policy = config?.policy;
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
      getModule: () => undefined
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    expect(captured.policy).toEqual({ mode: 'enforce' });
  });

  it('does not inject hubConfig.policy when ROUTECODEX_HUB_POLICY_MODE=off', async () => {
    process.env.ROUTECODEX_HUB_POLICY_MODE = 'off';
    tempConfigPath = await createTempUserConfig();

    const captured: { policy?: unknown } = {};

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
            captured.policy = config?.policy;
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
      getModule: () => undefined
    };

    const userConfigRaw = JSON.parse(await fs.readFile(tempConfigPath, 'utf8'));
    await server.initializeWithUserConfig(userConfigRaw);

    expect(captured.policy).toBeUndefined();
  });
});
