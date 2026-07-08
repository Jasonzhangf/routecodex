import { jest } from '@jest/globals';

const PROVIDER_V2_LOADER_PATH = '../../../../src/config/provider-v2-loader.ts';
const BOOTSTRAP_MODULE_PATH = '../../../../src/server/runtime/http-server/http-server-bootstrap.ts';
const ROUTING_INTEGRATIONS_PATH = '../../../../src/modules/llmswitch/bridge/routing-integrations.js';
const RUNTIME_INTEGRATIONS_PATH = '../../../../src/modules/llmswitch/bridge/runtime-integrations.js';
const RUNTIME_MANIFEST_SYMBOL = Symbol.for('routecodex.runtimeConfigManifest');

const mockCreateHubPipelineNative = jest.fn((config: Record<string, unknown>) => {
  const routeNames = Object.keys((config.virtualRouter as { routing?: Record<string, unknown> } | undefined)?.routing ?? {});
  return `hp_${routeNames.join('_') || 'primary'}_${mockCreateHubPipelineNative.mock.calls.length}`;
});
const mockExecuteHubPipelineNative = jest.fn(() => ({ requestId: 'req_mock', metadata: {} }));
const mockUpdateHubPipelineVirtualRouterConfigNative = jest.fn();
const mockUpdateHubPipelineEngineDepsNative = jest.fn();
const mockRouteHubPipelineVirtualRouterNative = jest.fn(() => ({
  target: { providerKey: 'asxs.crsa.gpt-5.4-mini' },
  decision: { routeName: 'default', providerKey: 'asxs.crsa.gpt-5.4-mini' },
  diagnostics: {},
}));
const mockDiagnoseHubPipelineVirtualRouterNative = jest.fn(() => ({ ok: true }));
const mockGetHubPipelineVirtualRouterStatusNative = jest.fn(() => ({ routes: {} }));
const mockMarkHubPipelineVirtualRouterConcurrencyScopeBusyNative = jest.fn();
const mockDisposeHubPipelineNative = jest.fn();

function unwrapProviderConfigs(providerConfigs: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(providerConfigs).map(([providerId, value]) => {
      const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      return [providerId, record.provider ?? record];
    })
  );
}

jest.unstable_mockModule(ROUTING_INTEGRATIONS_PATH, () => ({
  bootstrapVirtualRouterConfig: (input: Record<string, unknown>) => input,
  compileRouteCodexRuntimeManifest: async (input: any) => {
    const routingPolicyGroups = input?.userConfig?.virtualrouter?.routingPolicyGroups ?? {};
    const group =
      input?.options?.routingPolicyGroup
      ?? (routingPolicyGroups.default ? 'default' : Object.keys(routingPolicyGroups)[0])
      ?? 'gateway_priority_5520';
    const routingPolicyGroup = routingPolicyGroups?.[group] ?? {};
    const providers = unwrapProviderConfigs(input?.providerConfigs ?? {});
    const virtualRouterBootstrapInput = {
      providers,
      routing: routingPolicyGroup.routing ?? {},
    };
    return {
      manifestVersion: 'routecodex.runtime-config.v1',
      routingPolicyGroup: group,
      virtualRouterBootstrapInput,
      pipelineRuntimeConfig: {
        applyPatch: { mode: 'client', allow: ['apply_patch'] },
        routingProviderIds: Object.keys(providers),
        routingTiersByRoute: virtualRouterBootstrapInput.routing,
      },
      providerIds: Object.keys(providers),
      forwarderIds: [],
    };
  },
  collectRouteCodexV2ConfigSourceErrorsSync: () => [],
  normalizeRouteCodexV2RuntimeSourceSync: (userConfig: Record<string, unknown>) => userConfig,
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: () => undefined,
  extractRouteCodexMaterializedProviderConfigsSync: (userConfig: Record<string, unknown>) => {
    const virtualrouter = userConfig?.virtualrouter;
    if (!virtualrouter || typeof virtualrouter !== 'object' || Array.isArray(virtualrouter)) {
      return null;
    }
    const providers = (virtualrouter as Record<string, unknown>).providers;
    return providers && typeof providers === 'object' && !Array.isArray(providers)
      ? providers
      : null;
  },
  materializeRouteCodexUserConfigFromManifestSync: (userConfig: Record<string, unknown>) => userConfig,
  buildRouteCodexProviderProfilesSync: () => ({}),
  buildRouteCodexForwarderProfilesSync: () => ({}),
  parseRouteCodexTomlRecord: async () => ({}),
  parseRouteCodexTomlRecordSync: () => ({}),
  serializeRouteCodexTomlRecord: async () => '',
  serializeRouteCodexTomlRecordSync: () => '',
  updateRouteCodexTomlStringScalarInTable: async () => '',
  updateRouteCodexTomlStringScalarInTableSync: () => '',
  decodeRouteCodexUserConfigTextSync: () => ({ format: 'toml', parsed: {} }),
  decodeRouteCodexProviderConfigTextSync: () => ({ format: 'toml', parsed: {} }),
  detectRouteCodexUserConfigFormatSync: () => 'toml',
  detectRouteCodexProviderConfigFormatSync: () => 'toml',
  writeRouteCodexUserConfigFileNativeSync: () => undefined,
  writeRouteCodexProviderConfigFileNativeSync: () => undefined,
  updateRouteCodexUserConfigStringScalarNativeSync: () => '',
  loadRouteCodexConfigNativeSync: () => ({}),
  coerceRouteCodexProviderConfigV2: async (input: Record<string, unknown>) => input,
  coerceRouteCodexProviderConfigV2Sync: (input: Record<string, unknown>) => input,
  planRouteCodexProviderConfigV2FilesSync: () => [],
  resolveRouteCodexProviderConfigV2IdentitySync: () => ({ providerId: 'mock', alias: undefined }),
  loadRouteCodexProviderConfigsV2FromRootSync: () => ({}),
  planAuthFileResolutionNativeSync: () => ({ candidates: [] }),
  resolveAuthFileKeyNativeSync: () => undefined,
  planProviderConfigRootNativeSync: () => ({ rootDir: '', candidates: [] }),
  planRouteCodexConfigLoaderPathsNativeSync: () => ({ candidates: [] }),
  resolveRouteCodexConfigPathNativeSync: () => '/tmp/routecodex-test-config.toml',
  resolveRccPathNativeSync: (segments: string[] = []) => ['/tmp/.rcc', ...segments].join('/'),
  resolveRccSnapshotsDirNativeSync: () => '/tmp/.rcc/snapshots',
  resolveRccUserDirNativeSync: () => '/tmp/.rcc',
  resolveBaseDir: () => process.cwd(),
  createHubPipelineNative: mockCreateHubPipelineNative,
  executeHubPipelineNative: mockExecuteHubPipelineNative,
  updateHubPipelineVirtualRouterConfigNative: mockUpdateHubPipelineVirtualRouterConfigNative,
  updateHubPipelineEngineDepsNative: mockUpdateHubPipelineEngineDepsNative,
  routeHubPipelineVirtualRouterNative: mockRouteHubPipelineVirtualRouterNative,
  diagnoseHubPipelineVirtualRouterNative: mockDiagnoseHubPipelineVirtualRouterNative,
  getHubPipelineVirtualRouterStatusNative: mockGetHubPipelineVirtualRouterStatusNative,
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: mockMarkHubPipelineVirtualRouterConcurrencyScopeBusyNative,
  disposeHubPipelineNative: mockDisposeHubPipelineNative,
}));

jest.unstable_mockModule(RUNTIME_INTEGRATIONS_PATH, () => ({
  writeSnapshotViaHooks: async () => undefined,
  preloadCriticalBridgeRuntimeModules: async () => ({ loaded: [] }),
  captureResponsesRequestContextForRequest: async () => undefined,
  recordResponsesResponseForRequest: async () => undefined,
  resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
  lookupResponsesContinuationByResponseId: async () => null,
  resumeLatestResponsesContinuationByScope: async () => null,
  materializeLatestResponsesContinuationByScope: async () => null,
  rebindResponsesConversationRequestId: async () => undefined,
  clearResponsesConversationByRequestId: async () => undefined,
  finalizeResponsesConversationRequestRetention: async () => undefined,
  clearAllResponsesConversationState: async () => undefined,
  resetResponsesConversationStateForRestartSimulation: async () => undefined,
  clearUnresolvedResponsesConversationRequests: async () => 0,
  buildResponsesJsonFromSseStreamWithNative: async () => ({}),
  reportProviderErrorToRouterPolicy: async () => undefined,
  reportProviderSuccessToRouterPolicy: async () => undefined,
}));

function withRuntimeManifest(routerInput: any, pipelineRuntimeConfig: Record<string, unknown> = {}): any {
  Object.defineProperty(routerInput, RUNTIME_MANIFEST_SYMBOL, {
    value: {
      manifestVersion: 'routecodex.runtime-config.v1',
      routingPolicyGroup: null,
      virtualRouterBootstrapInput: routerInput,
      pipelineRuntimeConfig,
      providerIds: [],
      forwarderIds: [],
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return routerInput;
}

describe('http server runtime setup provider merge', () => {
  beforeEach(() => {
    mockCreateHubPipelineNative.mockClear();
    mockExecuteHubPipelineNative.mockClear();
    mockUpdateHubPipelineVirtualRouterConfigNative.mockClear();
    mockUpdateHubPipelineEngineDepsNative.mockClear();
    mockRouteHubPipelineVirtualRouterNative.mockClear();
    mockDiagnoseHubPipelineVirtualRouterNative.mockClear();
    mockGetHubPipelineVirtualRouterStatusNative.mockClear();
    mockMarkHubPipelineVirtualRouterConcurrencyScopeBusyNative.mockClear();
    mockDisposeHubPipelineNative.mockClear();
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('injects referenced provider-v2 configs into virtual router providers during setup', async () => {
    const capturedInputs: any[] = [];

    jest.unstable_mockModule(PROVIDER_V2_LOADER_PATH, () => ({
      loadProviderConfigsV2: async () => ({
        openai: {
          provider: {
            id: 'openai',
            auth: { type: 'apiKey' },
            entries: [
              { alias: 'key1', token: 'tok-1' },
              { alias: 'key2', token: 'tok-2' },
            ],
            models: { 'gpt-5.5-medium': {} },
          },
        },
      }),
    }));

    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');
    const { resolveRouterBootstrapConfig } = await import(BOOTSTRAP_MODULE_PATH);

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
        servertool: {
          apply_patch: { mode: 'freeform', allow: ['apply_patch'] },
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                thinking: [
                  { id: 'gateway-priority-5520-thinking', targets: ['openai.key1.gpt-5.5-medium'] },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: { getModule: () => undefined },
      hubPipeline: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      ensureProviderProfilesFromUserConfig: () => {},
      resolveRouterBootstrapConfig: async function (userConfig: any) { return await resolveRouterBootstrapConfig(this, userConfig); },
      bootstrapVirtualRouter: async (input: any) => {
        capturedInputs.push(JSON.parse(JSON.stringify(input)));
        return { config: input, runtime: {}, targetRuntime: {} };
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
    expect(capturedInputs[0]?.providers?.openai).toBeDefined();
    expect(capturedInputs[0]?.providers?.openai?.auth?.type).toBe('apiKey');
    expect(mockCreateHubPipelineNative).toHaveBeenCalledTimes(1);
    const primaryHubConfig = mockCreateHubPipelineNative.mock.calls[0]?.[0] as any;
    expect(typeof server.hubPipeline?.getVirtualRouter).toBe('function');
    expect(primaryHubConfig?.pipelineRuntimeConfig).toMatchObject({
      applyPatch: { mode: 'client', allow: ['apply_patch'] },
      routingProviderIds: ['openai'],
      routingTiersByRoute: {
        thinking: [
          expect.objectContaining({
            id: 'gateway-priority-5520-thinking',
            targets: ['openai.key1.gpt-5.5-medium'],
          }),
        ],
      },
    });
  });

  it('does not propagate provider profile autoRetry into runtime', async () => {
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
    expect((patched as Record<string, unknown>).autoRetry).toBeUndefined();
  });

  it('preserves already materialized virtualrouter.providers when routingPolicyGroups exist', async () => {
    const { resolveRouterBootstrapConfig } = await import(BOOTSTRAP_MODULE_PATH);

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
    const input = await resolveRouterBootstrapConfig(server, materializedConfig as any);

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

  it('derives runtime routing scope from the real routing config instead of an empty routing placeholder', async () => {
    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');

    const capturedScopes: any[] = [];
    const providerRuntimeArtifacts = {
      config: {
        routing: {
          default: [
            {
              id: 'gateway-priority-5520-default',
              targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
            },
          ],
        },
      },
      runtime: {},
      targetRuntime: {
        'asxs.crsa.gpt-5.4-mini': {
          providerId: 'asxs',
          providerType: 'responses',
          runtimeKey: 'asxs.crsa',
        },
        '1token.key1.gpt-5.4-mini': {
          providerId: '1token',
          providerType: 'responses',
          runtimeKey: '1token.key1',
        },
        'minimax.key1.MiniMax-M3': {
          providerId: 'minimax',
          providerType: 'anthropic',
          runtimeKey: 'minimax.key1',
        },
        'tokenrelay.key1.deepseek-v4-pro': {
          providerId: 'tokenrelay',
          providerType: 'responses',
          runtimeKey: 'tokenrelay.key1',
        },
      },
    };

    const server: any = {
      userConfig: {
        httpserver: {
          ports: [
            {
              port: 5520,
              host: '127.0.0.1',
              mode: 'router',
              routingPolicyGroup: 'gateway_priority_5520',
            },
            {
              port: 5557,
              host: '127.0.0.1',
              mode: 'provider',
              providerBinding: 'tokenrelay.deepseek-v4-pro',
            },
          ],
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [
                  {
                    id: 'gateway-priority-5520-default',
                    targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
                  },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: {
        getModule: () => undefined,
      },
      hubPipeline: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      ensureProviderProfilesFromUserConfig: () => {},
      resolveRouterBootstrapConfig: async () => withRuntimeManifest({ routing: { default: [] } }, { applyPatch: { mode: 'client' } }),
      bootstrapVirtualRouter: async () => providerRuntimeArtifacts,
      isQuotaRoutingEnabled: () => false,
      initializeProviderRuntimes: async () => {},
      initializeRouteErrorHub: async () => {},
      startSessionDaemonInjectLoop: () => {},
      pipelineLogger: { logDebug: () => {}, logError: () => {}, logModule: () => {}, getRecentLogs: () => [] },
      getErrorHandlingShim: () => ({ handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }),
      createDebugCenterShim: () => ({ logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] }),
    };

    await setupRuntime(server, server.userConfig as any);
    capturedScopes.push(server.routingProviderScope);

    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]?.providerIds).toEqual(expect.arrayContaining(['asxs', '1token', 'minimax', 'tokenrelay']));
    expect(capturedScopes[0]?.providerKeys).toEqual(expect.arrayContaining([
      'asxs.crsa.gpt-5.4-mini',
      '1token.key1.gpt-5.4-mini',
      'minimax.key1.minimax-m3',
      'tokenrelay.key1.deepseek-v4-pro',
    ]));
  });

  it('merges routing config across router groups before deriving runtime provider scope', async () => {
    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');

    const capturedScopes: any[] = [];
    const capturedArtifacts: any[] = [];
    const primaryArtifacts = {
      config: {
        routing: {
          provider: [
            {
              id: 'tokenrelay-provider',
              targets: ['tokenrelay.key1.deepseek-v4-pro'],
            },
          ],
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [
                  {
                    id: 'gateway-priority-5520-default',
                    targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
                  },
                ],
              },
            },
          },
        },
      },
      runtime: {},
      targetRuntime: {
        'tokenrelay.key1.deepseek-v4-pro': {
          providerId: 'tokenrelay',
          providerType: 'responses',
          runtimeKey: 'tokenrelay.key1',
        },
      },
    };
    const groupArtifacts = {
      config: {
        routing: {
          default: [
            {
              id: 'gateway-priority-5520-default',
              targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
            },
          ],
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [
                  {
                    id: 'gateway-priority-5520-default',
                    targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
                  },
                ],
              },
            },
          },
        },
      },
      runtime: {},
      targetRuntime: {
        'asxs.crsa.gpt-5.4-mini': {
          providerId: 'asxs',
          providerType: 'responses',
          runtimeKey: 'asxs.crsa',
        },
        '1token.key1.gpt-5.4-mini': {
          providerId: '1token',
          providerType: 'responses',
          runtimeKey: '1token.key1',
        },
        'minimax.key1.MiniMax-M3': {
          providerId: 'minimax',
          providerType: 'anthropic',
          runtimeKey: 'minimax.key1',
        },
      },
    };

    const server: any = {
      userConfig: {
        httpserver: {
          ports: [
            {
              port: 5520,
              host: '127.0.0.1',
              mode: 'router',
              routingPolicyGroup: 'gateway_priority_5520',
            },
            {
              port: 5557,
              host: '127.0.0.1',
              mode: 'provider',
              providerBinding: 'tokenrelay.deepseek-v4-pro',
            },
          ],
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [
                  {
                    id: 'gateway-priority-5520-default',
                    targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
                  },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: {
        getModule: () => undefined,
      },
      hubPipeline: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      getPortConfigs: function () {
        return this.userConfig.httpserver.ports;
      },
      ensureProviderProfilesFromUserConfig: () => {},
      buildHubPipelineConfigForRoutingPolicyGroup: async (group: string, baseConfig: any) => {
        const routerInput = {
          routing: {
            default: [
              {
                id: `${group}-default`,
                targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
              },
            ],
          },
        };
        const artifacts = await server.bootstrapVirtualRouter(routerInput);
        return {
          ...baseConfig,
          virtualRouter: artifacts.config,
        };
      },
      resolveRouterBootstrapConfig: async () => withRuntimeManifest({ routing: { provider: [] } }, { hitLog: { enabled: true } }),
      bootstrapVirtualRouter: async (input: any) => {
        const defaultTargets =
          Array.isArray(input?.routing?.default)
            ? input.routing.default.flatMap((entry: any) =>
                Array.isArray(entry?.targets) ? entry.targets : []
              )
            : [];
        if (defaultTargets.includes('asxs.crsa.gpt-5.4-mini')) {
          return groupArtifacts;
        }
        return primaryArtifacts;
      },
      isQuotaRoutingEnabled: () => false,
      initializeProviderRuntimes: async (artifacts: any) => {
        capturedArtifacts.push(artifacts);
      },
      initializeRouteErrorHub: async () => {},
      startSessionDaemonInjectLoop: () => {},
      pipelineLogger: { logDebug: () => {}, logError: () => {}, logModule: () => {}, getRecentLogs: () => [] },
      getErrorHandlingShim: () => ({ handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }),
      createDebugCenterShim: () => ({ logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] }),
    };

    await setupRuntime(server, server.userConfig as any);
    capturedScopes.push(server.routingProviderScope);

    expect(capturedArtifacts).toHaveLength(1);
    expect(typeof server.hubPipeline?.getVirtualRouter).toBe('function');
    expect(typeof server.hubPipelinesByRoutingPolicyGroup.get('gateway_priority_5520')?.getVirtualRouter).toBe('function');
    expect(capturedArtifacts[0]?.config?.routing).toMatchObject({
      provider: [
        expect.objectContaining({ targets: ['tokenrelay.key1.deepseek-v4-pro'] }),
      ],
      default: [
        expect.objectContaining({
          targets: ['asxs.crsa.gpt-5.4-mini', '1token.key1.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
        }),
      ],
    });
    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]?.providerIds).toEqual(expect.arrayContaining(['tokenrelay', 'asxs', '1token', 'minimax']));
    expect(capturedScopes[0]?.providerKeys).toEqual(expect.arrayContaining([
      'tokenrelay.key1.deepseek-v4-pro',
      'asxs.crsa.gpt-5.4-mini',
      '1token.key1.gpt-5.4-mini',
      'minimax.key1.minimax-m3',
    ]));
  });

  it('derives runtime routing scope from forwarder-expanded provider ids', async () => {
    const { setupRuntime } = await import('../../../../src/server/runtime/http-server/http-server-runtime-setup.ts');

    const capturedScopes: any[] = [];
    const providerRuntimeArtifacts = {
      config: {
        routing: {
          default: [
            {
              id: 'gateway-priority-5520-default',
              targets: ['fwd.paid.gpt-5.4-mini', 'fwd.minimax.MiniMax-M3'],
            },
          ],
        },
        forwarders: {
          'fwd.paid.gpt-5.4-mini': {
            targets: [
              { providerId: 'asxs', providerKey: 'asxs.crsa.gpt-5.4-mini' },
              { providerId: '1token', providerKey: '1token.key1.gpt-5.4-mini' },
            ],
          },
          'fwd.minimax.MiniMax-M3': {
            targets: [
              { providerId: 'minimax', providerKey: 'minimax.key1.MiniMax-M3' },
            ],
          },
        },
      },
      runtime: {},
      targetRuntime: {
        'asxs.crsa.gpt-5.4-mini': {
          providerId: 'asxs',
          providerType: 'responses',
          runtimeKey: 'asxs.crsa',
        },
        '1token.key1.gpt-5.4-mini': {
          providerId: '1token',
          providerType: 'responses',
          runtimeKey: '1token.key1',
        },
        'minimax.key1.MiniMax-M3': {
          providerId: 'minimax',
          providerType: 'anthropic',
          runtimeKey: 'minimax.key1',
        },
        'tokenrelay.key1.deepseek-v4-pro': {
          providerId: 'tokenrelay',
          providerType: 'responses',
          runtimeKey: 'tokenrelay.key1',
        },
      },
    };

    const server: any = {
      userConfig: {
        httpserver: {
          ports: [
            {
              port: 5520,
              host: '127.0.0.1',
              mode: 'router',
              routingPolicyGroup: 'gateway_priority_5520',
            },
            {
              port: 5557,
              host: '127.0.0.1',
              mode: 'provider',
              providerBinding: 'tokenrelay.deepseek-v4-pro',
            },
          ],
        },
        virtualrouter: {
          routingPolicyGroups: {
            gateway_priority_5520: {
              routing: {
                default: [
                  {
                    id: 'gateway-priority-5520-default',
                    targets: ['fwd.paid.gpt-5.4-mini', 'fwd.minimax.MiniMax-M3'],
                  },
                ],
              },
            },
          },
        },
      },
      config: { configPath: 'test-config.json' },
      managerDaemon: { getModule: () => undefined },
      hubPipeline: null,
      currentRouterArtifacts: null,
      routingProviderScope: null,
      hubPolicyMode: 'off',
      ensureProviderProfilesFromUserConfig: () => {},
      resolveRouterBootstrapConfig: async () => withRuntimeManifest({ routing: { default: [] } }, { applyPatch: { mode: 'client' } }),
      bootstrapVirtualRouter: async () => providerRuntimeArtifacts,
      isQuotaRoutingEnabled: () => false,
      initializeProviderRuntimes: async () => {},
      initializeRouteErrorHub: async () => {},
      startSessionDaemonInjectLoop: () => {},
      pipelineLogger: { logDebug: () => {}, logError: () => {}, logModule: () => {}, getRecentLogs: () => [] },
      getErrorHandlingShim: () => ({ handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }),
      createDebugCenterShim: () => ({ logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] }),
    };

    await setupRuntime(server, server.userConfig as any);
    capturedScopes.push(server.routingProviderScope);

    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]?.providerIds).toEqual(expect.arrayContaining(['asxs', '1token', 'minimax', 'tokenrelay']));
    expect(capturedScopes[0]?.providerKeys).toEqual(expect.arrayContaining([
      'asxs.crsa.gpt-5.4-mini',
      '1token.key1.gpt-5.4-mini',
      'minimax.key1.minimax-m3',
      'tokenrelay.key1.deepseek-v4-pro',
    ]));
  });

});
