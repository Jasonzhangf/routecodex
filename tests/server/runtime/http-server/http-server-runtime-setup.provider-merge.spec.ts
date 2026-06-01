import { jest } from '@jest/globals';

const BRIDGE_MODULE_PATH = '../../../../src/modules/llmswitch/bridge.ts';
const PROVIDER_V2_LOADER_PATH = '../../../../src/config/provider-v2-loader.ts';
const BOOTSTRAP_MODULE_PATH = '../../../../src/server/runtime/http-server/http-server-bootstrap.ts';

describe('http server runtime setup provider merge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('injects referenced provider-v2 configs into virtual router providers during setup', async () => {
    const capturedInputs: any[] = [];

    jest.unstable_mockModule(PROVIDER_V2_LOADER_PATH, () => ({
      loadProviderConfigsV2: async () => ({
        windsurf: {
          provider: {
            id: 'windsurf',
            auth: { type: 'windsurf-account' },
            entries: [
              { alias: 'ws-pro-1', token: 'tok-1' },
              { alias: 'ws-pro-2', token: 'tok-2' },
            ],
            models: { 'gpt-5.5-medium': {} },
          },
        },
      }),
    }));

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      bootstrapVirtualRouterConfig: (input: any) => input,
      getHubPipelineCtor: async () => class HubPipelineMock { constructor(_config: any) {} updateVirtualRouterConfig(): void {} },
      preloadCriticalBridgeRuntimeModules: async () => ({ loaded: [] }),
      loadRoutingInstructionStateSync: () => null,
      saveRoutingInstructionStateAsync: async () => {},
      saveRoutingInstructionStateSync: () => {},
      syncStoplessGoalStateFromRequest: () => null,
      persistStoplessGoalStateSnapshot: () => {},
      readStoplessGoalState: () => null,
      extractSessionIdentifiersFromMetadata: () => ({}),
      getStatsCenterSafe: () => null,
      getLlmsStatsSnapshot: () => ({}),
    }));

    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');
    const { resolveVirtualRouterInput } = await import(BOOTSTRAP_MODULE_PATH);

    const routerInput = {
      providers: {
        inline: {
          type: 'openai',
          auth: { type: 'apiKey', value: 'inline-key' },
          models: { 'gpt-5.3-codex': {} },
        },
      },
      routing: { default: ['inline.gpt-5.3-codex'] },
    };

    const server: any = {
      userConfig: {
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                thinking: [
                  { id: 'gateway-priority-5520-thinking', targets: ['windsurf.ws-pro-1.gpt-5.5-medium'] },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: { getModule: () => undefined },
      hubPipeline: null,
      hubPipelineCtor: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      ensureProviderProfilesFromUserConfig: () => {},
      resolveVirtualRouterInput: async function (userConfig: any) { return await resolveVirtualRouterInput(this, userConfig); },
      bootstrapVirtualRouter: async (input: any) => {
        capturedInputs.push(JSON.parse(JSON.stringify(input)));
        return { config: input, runtime: {}, targetRuntime: {} };
      },
      ensureHubPipelineCtor: async () =>
        class HubPipelineMock {
          constructor(_config: any) {}
          updateVirtualRouterConfig(): void {}
        },
      isQuotaRoutingEnabled: () => false,
      initializeProviderRuntimes: async () => {},
      initializeRouteErrorHub: async () => {},
      startSessionDaemonInjectLoop: () => {},
      pipelineLogger: { logDebug: () => {}, logError: () => {}, logModule: () => {}, getRecentLogs: () => [] },
      getErrorHandlingShim: () => ({ handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }),
      createDebugCenterShim: () => ({ logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] }),
    };

    await setupRuntime(server, server.userConfig as any);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.providers?.inline).toBeUndefined();
    expect(capturedInputs[0]?.providers?.windsurf).toBeDefined();
    expect(capturedInputs[0]?.providers?.windsurf?.auth?.type).toBe('windsurf-account');
  });


  it('injects direct windsurf devin-token auth from provider-v2 configs during setup', async () => {
    const capturedInputs: any[] = [];

    jest.unstable_mockModule(PROVIDER_V2_LOADER_PATH, () => ({
      loadProviderConfigsV2: async () => ({
        windsurf: {
          provider: {
            id: 'windsurf',
            auth: {
              type: 'windsurf-devin-token',
              apiKey: 'devin-session-token$cfg-direct',
              tokenFile: '~/.rcc/auth/windsurf-devin-token-1.json'
            },
            models: { 'gpt-5.5-medium': {} },
          },
        },
      }),
    }));

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      bootstrapVirtualRouterConfig: (input: any) => input,
      getHubPipelineCtor: async () => class HubPipelineMock { constructor(_config: any) {} updateVirtualRouterConfig(): void {} },
      preloadCriticalBridgeRuntimeModules: async () => ({ loaded: [] }),
      loadRoutingInstructionStateSync: () => null,
      saveRoutingInstructionStateAsync: async () => {},
      saveRoutingInstructionStateSync: () => {},
      syncStoplessGoalStateFromRequest: () => null,
      persistStoplessGoalStateSnapshot: () => {},
      readStoplessGoalState: () => null,
      extractSessionIdentifiersFromMetadata: () => ({}),
      getStatsCenterSafe: () => null,
      getLlmsStatsSnapshot: () => ({}),
    }));

    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');
    const { resolveVirtualRouterInput } = await import(BOOTSTRAP_MODULE_PATH);

    const server: any = {
      userConfig: {
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                thinking: [
                  { id: 'gateway-priority-5520-thinking', targets: ['windsurf.gpt-5.5-medium'] },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: { getModule: () => undefined },
      hubPipeline: null,
      hubPipelineCtor: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      ensureProviderProfilesFromUserConfig: () => {},
      resolveVirtualRouterInput: async function (userConfig: any) { return await resolveVirtualRouterInput(this, userConfig); },
      bootstrapVirtualRouter: async (input: any) => { capturedInputs.push(JSON.parse(JSON.stringify(input))); return { config: input, runtime: {}, targetRuntime: {} }; },
      ensureHubPipelineCtor: async () => class HubPipelineMock { constructor(_config: any) {} updateVirtualRouterConfig(): void {} },
      isQuotaRoutingEnabled: () => false,
      initializeProviderRuntimes: async () => {},
      initializeRouteErrorHub: async () => {},
      startSessionDaemonInjectLoop: () => {},
      pipelineLogger: { logDebug: () => {}, logError: () => {}, logModule: () => {}, getRecentLogs: () => [] },
      getErrorHandlingShim: () => ({ handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }),
      createDebugCenterShim: () => ({ logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] }),
    };

    await setupRuntime(server, server.userConfig as any);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.providers?.windsurf?.auth?.type).toBe('windsurf-devin-token');
    expect(capturedInputs[0]?.providers?.windsurf?.auth?.apiKey).toBe('devin-session-token$cfg-direct');
    expect(capturedInputs[0]?.providers?.windsurf?.auth?.tokenFile).toBe('~/.rcc/auth/windsurf-devin-token-1.json');
  });

  it('applies windsurf profile metadata into runtime extensions for cascade local-runtime prerequisites', async () => {
    const { applyProviderProfileOverrides } = await import('../../../../src/server/runtime/http-server/http-server-bootstrap.ts');

    const server: any = {
      providerProfileIndex: new Map([
        ['windsurf', {
          id: 'windsurf',
          protocol: 'openai',
          transport: {},
          auth: { kind: 'apikey' },
          compatibilityProfile: 'chat:windsurf',
          metadata: {
            windsurf: {
              lsPort: 42101,
              csrfToken: 'windsurf-api-csrf-fixed-token',
              sessionId: 'session-from-profile',
              workspacePath: '/tmp/windsurf-workspace',
              workspaceUri: 'file:///tmp/windsurf-workspace',
              pollIntervalMs: 500,
              pollMaxWaitMs: 120000
            }
          }
        }]
      ])
    };

    const runtime: any = {
      runtimeKey: 'windsurf.ws-pro-1',
      providerId: 'windsurf',
      providerType: 'openai',
      endpoint: '',
      compatibilityProfile: 'chat:windsurf',
      auth: {
        type: 'apikey',
        rawType: 'windsurf-devin-token',
        value: 'devin-session-token$cfg-direct'
      }
    };

    const patched = applyProviderProfileOverrides(server, runtime);
    expect(patched.extensions?.windsurf).toEqual({
      lsPort: 42101,
      csrfToken: 'windsurf-api-csrf-fixed-token',
      sessionId: 'session-from-profile',
      workspacePath: '/tmp/windsurf-workspace',
      workspaceUri: 'file:///tmp/windsurf-workspace',
      pollIntervalMs: 500,
      pollMaxWaitMs: 120000
    });
  });

  it('RED: applies provider profile autoRetry metadata into runtime', async () => {
    const { applyProviderProfileOverrides } = await import('../../../../src/server/runtime/http-server/http-server-bootstrap.ts');

    const server: any = {
      providerProfileIndex: new Map([
        ['minimax', {
          id: 'minimax',
          protocol: 'openai',
          transport: {},
          auth: { kind: 'apikey' },
          metadata: {
            autoRetry: {
              threshold: 3,
              codes: ['0.8200']
            }
          }
        }]
      ])
    };

    const runtime: any = {
      runtimeKey: 'minimax.key1',
      providerId: 'minimax',
      providerType: 'openai',
      endpoint: 'https://api.minimax.example/v1',
      auth: {
        type: 'apikey',
        value: 'mock-key'
      }
    };

    const patched = applyProviderProfileOverrides(server, runtime);
    expect(patched.autoRetry).toEqual({
      threshold: 3,
      codes: ['0.8200']
    });
  });

  it('preserves already materialized virtualrouter.providers when routingPolicyGroups exist', async () => {
    const { resolveVirtualRouterInput } = await import(BOOTSTRAP_MODULE_PATH);

    const materializedConfig = {
      virtualrouter: {
        providers: {
          mock: {
            id: 'mock',
            auth: {
              type: 'apikey',
              entries: [{ alias: 'default', value: 'mock-key' }]
            },
            models: {
              'gpt-5.1': { supportsStreaming: true }
            }
          }
        },
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                { id: 'mock-default', targets: ['mock.default.gpt-5.1'] }
              ]
            }
          }
        }
      }
    };

    const server: any = {};
    const input = await resolveVirtualRouterInput(server, materializedConfig as any);

    expect(input).toMatchObject({
      providers: {
        mock: {
          id: 'mock'
        }
      },
      routing: {
        default: [
          expect.objectContaining({
            targets: ['mock.default.gpt-5.1']
          })
        ]
      }
    });
  });

});
