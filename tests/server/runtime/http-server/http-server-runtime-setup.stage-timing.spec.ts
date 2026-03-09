import { jest } from '@jest/globals';

describe('http server runtime setup stage timing defaults', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function createServerStub() {
    return {
      userConfig: undefined as unknown,
      currentRouterArtifacts: undefined as unknown,
      hubPolicyMode: 'off',
      hubPipeline: null as unknown,
      hubPipelineConfigForShadow: null as unknown,
      hubPipelineEngineShadow: null as unknown,
      managerDaemon: undefined,
      ensureProviderProfilesFromUserConfig: jest.fn(),
      resolveVirtualRouterInput: jest.fn(() => ({ routes: [] })),
      bootstrapVirtualRouter: jest.fn(async () => ({ config: { routes: [] } })),
      ensureHubPipelineCtor: jest.fn(async () => class FakeHubPipeline {
        constructor(_config: unknown) {}
      }),
      initializeProviderRuntimes: jest.fn(async () => undefined),
      startSessionDaemonInjectLoop: jest.fn(),
      isQuotaRoutingEnabled: jest.fn(() => false),
    };
  }

  async function importSetupRuntimeWithMode(mode: 'dev' | 'release') {
    jest.unstable_mockModule('../../../../src/build-info.js', () => ({
      buildInfo: {
        mode,
        version: 'test',
        buildTime: '2026-03-09T00:00:00.000Z',
      },
    }));
    return import('../../../../src/server/runtime/http-server/http-server-runtime-setup.js');
  }

  it('enables dev stage timing detail by default', async () => {
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL;

    const { setupRuntime } = await importSetupRuntimeWithMode('dev');
    const server = createServerStub();
    await setupRuntime(server as any, {});

    expect(process.env.ROUTECODEX_STAGE_TIMING).toBe('1');
    expect(process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL).toBe('1');
  });

  it('keeps release hub detail disabled by default', async () => {
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL;

    const { setupRuntime } = await importSetupRuntimeWithMode('release');
    const server = createServerStub();
    await setupRuntime(server as any, {});

    expect(process.env.ROUTECODEX_STAGE_TIMING).toBeUndefined();
    expect(process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL).toBe('0');
  });
});
