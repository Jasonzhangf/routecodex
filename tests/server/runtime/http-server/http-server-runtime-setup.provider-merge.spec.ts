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
      resolveClockConfigSnapshot: () => null,
      startClockDaemonIfNeededSnapshot: () => {},
      setClockRuntimeHooksSnapshot: () => {},
      buildHeartbeatInjectTextSnapshot: () => null,
      resolveHeartbeatConfigSnapshot: () => null,
      startHeartbeatDaemonIfNeededSnapshot: () => {},
      setHeartbeatRuntimeHooksSnapshot: () => {},
      loadHeartbeatStateSnapshot: () => null,
      listHeartbeatStatesSnapshot: () => [],
      listHeartbeatHistorySnapshot: () => [],
      appendHeartbeatHistoryEventSnapshot: () => {},
      setHeartbeatEnabledSnapshot: () => {},
      runHeartbeatDaemonTickSnapshot: () => {},
      reserveClockDueTasks: () => [],
      commitClockDueReservation: () => {},
      listClockSessionIdsSnapshot: () => [],
      listClockTasksSnapshot: () => [],
      scheduleClockTasksSnapshot: () => [],
      updateClockTaskSnapshot: () => null,
      cancelClockTaskSnapshot: () => false,
      clearClockTasksSnapshot: () => {},
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
});
