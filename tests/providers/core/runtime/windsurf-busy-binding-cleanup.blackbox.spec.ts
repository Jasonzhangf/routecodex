import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

function trajectoryStatusProto(status: number): Buffer {
  return Buffer.from([16, status]);
}

describe('Windsurf busy binding cleanup blackbox', () => {
  const createdProviders: any[] = [];
  let WindsurfChatProvider: any;

  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  afterEach(async () => {
    await Promise.allSettled(createdProviders.map(async (p: any) => {
      if (p && typeof p.dispose === 'function') await p.dispose();
    }));
    createdProviders.length = 0;
    jest.clearAllMocks();
  });

  function createProvider(): any {
    const p = new WindsurfChatProvider({
      type: 'openai-standard',
      config: {
        providerType: 'openai',
        baseUrl: 'http://localhost:3003',
        model: 'gpt-5.4-medium',
        auth: { type: 'apikey', apiKey: 'devin-session-token$test', rawType: 'windsurf-devin-token' },
        windsurfRuntime: {
          lsPort: 39399,
          csrfToken: 'csrf',
          cascadeBusyMaxRetries: 0,
          cascadeBusyPerAttemptWaitMs: 1,
          cascadeBusyPollIntervalMs: 1,
        },
      },
    } as any, deps) as any;
    createdProviders.push(p);
    return p;
  }

  test('busy exhausted request rewarms to fresh cascade in same request', async () => {
    const provider = createProvider();
    jest.spyOn(provider, 'resolveCascadeApiKey').mockResolvedValue('devin-session-token$test');
    jest.spyOn(provider, 'resolveManagedRuntimeOptions').mockResolvedValue({ lsPort: 39399, csrfToken: 'csrf' });
    jest.spyOn(provider, 'sleepWindsurfCascadeBusyRetry').mockResolvedValue(undefined);
    jest.spyOn(provider, 'grpcUnaryLocal').mockImplementation(async (pathName: string) => {
      if (pathName.endsWith('/GetCascadeTrajectory')) return trajectoryStatusProto(2);
      return Buffer.alloc(0);
    });

    const startedCascadeIds: string[] = [];
    const startCascadeIds = ['stuck-cascade', 'fresh-cascade'];
    jest.spyOn(provider, 'sendStartCascade').mockImplementation(async () => {
      const next = startCascadeIds.shift();
      if (!next) throw new Error('unexpected cascade start');
      startedCascadeIds.push(next);
      return next;
    });

    const sentCascadeIds: string[] = [];
    jest.spyOn(provider, 'sendCascadeMessage').mockImplementation(async (args: { cascadeId: string }) => {
      sentCascadeIds.push(args.cascadeId);
      if (args.cascadeId === 'stuck-cascade') {
        throw Object.assign(new Error('executor is not idle: CASCADE_RUN_STATUS_RUNNING'), {
          code: 'WINDSURF_CASCADE_BUSY',
          status: 429,
          retryable: true,
        });
      }
    });
    jest.spyOn(provider, 'pollCascadeTrajectorySteps').mockResolvedValue({
      candidate: { role: 'assistant', content: 'ok on fresh cascade' },
      usage: { inputTokens: 1, outputTokens: 1 },
      stepOffset: 1,
    });

    const result = await provider.sendRequestInternal({
      body: { model: 'gpt-5.4-medium', messages: [{ role: 'user', content: 'busy then rewarmed' }] },
    });

    expect(startedCascadeIds).toEqual(['stuck-cascade', 'fresh-cascade']);
    expect(sentCascadeIds[0]).toBe('stuck-cascade');
    expect(sentCascadeIds[sentCascadeIds.length - 1]).toBe('fresh-cascade');
    expect((result as any)?.choices?.[0]?.message?.content).toBe('ok on fresh cascade');
  });
});
