import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderRuntimeProfile } from '../../../../src/providers/core/api/provider-types.js';
import {
  ProviderTrafficGovernor,
  ProviderTrafficSaturatedError,
  resolveProviderTrafficPolicy
} from '../../../../src/server/runtime/http-server/provider-traffic-governor.js';

function createRuntime(overrides?: Partial<ProviderRuntimeProfile>): ProviderRuntimeProfile {
  return {
    runtimeKey: 'demo.runtime',
    providerId: 'demo',
    providerType: 'openai',
    providerFamily: 'openai',
    endpoint: 'https://example.com/v1',
    auth: {
      type: 'apikey',
      value: 'demo'
    },
    ...overrides
  };
}

describe('provider-traffic-governor', () => {
  const originalAdaptivePath = process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH;

  afterEach(() => {
    if (typeof originalAdaptivePath === 'string') {
      process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = originalAdaptivePath;
    } else {
      delete process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH;
    }
  });

  it('applies generic defaults when provider config omits concurrency/rpm', () => {
    const deepseekPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'deepseek',
        providerFamily: 'deepseek',
        runtimeKey: 'deepseek.alias'
      }),
      'deepseek.alias.deepseek-chat'
    );
    expect(deepseekPolicy.concurrency.maxInFlight).toBe(2);
    expect(deepseekPolicy.rpm.requestsPerMinute).toBe(120);

    const deepseekWebPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'deepseek-web',
        providerFamily: 'deepseek-web',
        runtimeKey: 'deepseek-web.alias',
        compatibilityProfile: 'chat:deepseek-web'
      }),
      'deepseek-web.alias.deepseek-v4-pro'
    );
    expect(deepseekWebPolicy.concurrency.maxInFlight).toBe(1);
    expect(deepseekWebPolicy.rpm.requestsPerMinute).toBe(60);

    const tabglmPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'tabglm',
        providerFamily: 'tabglm',
        runtimeKey: 'tabglm.key1'
      }),
      'tabglm.key1.glm-5.1'
    );
    expect(tabglmPolicy.concurrency.maxInFlight).toBe(2);
    expect(tabglmPolicy.rpm.requestsPerMinute).toBe(120);

    const genericPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'openrouter',
        providerFamily: 'openrouter',
        runtimeKey: 'openrouter.key1'
      }),
      'openrouter.key1.qwen'
    );
    expect(genericPolicy.concurrency.maxInFlight).toBe(2);
    expect(genericPolicy.rpm.requestsPerMinute).toBe(120);

    const crsPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'crs',
        providerFamily: 'crs',
        runtimeKey: 'crs.key1'
      }),
      'crs.key1.gpt-5.3-codex'
    );
    expect(crsPolicy.concurrency.maxInFlight).toBe(2);
    expect(crsPolicy.rpm.requestsPerMinute).toBe(120);
  });

  it('honors explicit runtime overrides for non-web providers', () => {
    const policy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'openrouter',
        providerFamily: 'openrouter',
        runtimeKey: 'openrouter.1',
        concurrency: {
          maxInFlight: 3,
          acquireTimeoutMs: 12000,
          staleLeaseMs: 150000
        },
        rpm: {
          requestsPerMinute: 77,
          acquireTimeoutMs: 23000
        }
      }),
      'openrouter.1.qwen3.6-plus'
    );
    expect(policy.concurrency).toEqual({
      maxInFlight: 3,
      acquireTimeoutMs: 12000,
      staleLeaseMs: 150000
    });
    expect(policy.rpm.requestsPerMinute).toBe(77);
    expect(policy.rpm.acquireTimeoutMs).toBe(23000);
  });

  it('honors explicit runtime concurrency instead of forcing global single-flight', () => {
    const policy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'openai',
        providerFamily: 'openai',
        runtimeKey: 'openai.key4',
        concurrency: {
          maxInFlight: 3,
          acquireTimeoutMs: 12000,
          staleLeaseMs: 150000
        }
      }),
      'openai.key4.gpt-5.4-medium'
    );
    expect(policy.concurrency.maxInFlight).toBe(3);
    expect(policy.concurrency.acquireTimeoutMs).toBe(12000);
  });



  it('runtime must not be clamped to single concurrency by persisted adaptive state', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-${process.pid}-${randomUUID()}`);
    const adaptivePath = path.join(rootDir, 'dynamic-concurrency-overrides.json');
    const prevAdaptivePath = process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH;
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptivePath;
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(adaptivePath, JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      runtimes: {
        'openai.key4': {
          baseCap: 3,
          minCap: 1,
          hardMaxCap: 6,
          currentCap: 2,
          tentativeCap: 3,
          safeCap: 2,
          cooldownUntilMs: 0,
          saturatedNo429Streak: 5,
          saturated429Streak: 0,
          triedIncreaseCaps: [2],
          updatedAtMs: Date.now()
        }
      }
    }));
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'openai.key4',
      providerId: 'openai',
      providerFamily: 'openai',
      concurrency: { maxInFlight: 3, acquireTimeoutMs: 150, staleLeaseMs: 60000 }
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'openai.key4.gpt-5.4-medium',
        requestId: 'provider-first',
        runtime
      });
      expect(first.policy.concurrency.maxInFlight).toBe(3);
      const second = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'openai.key4.gpt-5.3-codex',
        requestId: 'provider-second',
        runtime
      });
      await governor.release(first.permit);
      await governor.release(second.permit);
    } finally {
      if (typeof prevAdaptivePath === 'string') {
        process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = prevAdaptivePath;
      } else {
        delete process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH;
      }
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('defaults to shared provider-traffic root outside test workers', async () => {
    const prevShared = process.env.ROUTECODEX_PROVIDER_TRAFFIC_SHARED;
    const prevServerId = process.env.ROUTECODEX_SERVER_ID;
    delete process.env.ROUTECODEX_PROVIDER_TRAFFIC_SHARED;
    process.env.ROUTECODEX_SERVER_ID = 'host-a:10000';
    const governor = new ProviderTrafficGovernor();
    const runtime = createRuntime({
      runtimeKey: 'deepseek-web.berg',
      providerId: 'deepseek-web',
      providerFamily: 'deepseek-web',
      concurrency: { maxInFlight: 1, acquireTimeoutMs: 500, staleLeaseMs: 60000 },
      rpm: { requestsPerMinute: 60, acquireTimeoutMs: 500 }
    });
    const acquired = await governor.acquire({
      runtimeKey: runtime.runtimeKey,
      providerKey: 'deepseek-web.berg.deepseek-v4-pro',
      requestId: 'shared-root-check',
      runtime
    });
    const stateKey = encodeURIComponent(runtime.runtimeKey);
    expect(acquired.permit.stateKey).toBe(stateKey);
    await governor.release(acquired.permit);
    if (typeof prevShared === 'string') process.env.ROUTECODEX_PROVIDER_TRAFFIC_SHARED = prevShared; else delete process.env.ROUTECODEX_PROVIDER_TRAFFIC_SHARED;
    if (typeof prevServerId === 'string') process.env.ROUTECODEX_SERVER_ID = prevServerId; else delete process.env.ROUTECODEX_SERVER_ID;
  });

  it('keeps leases from another server id alive during prune', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-cross-server-${process.pid}-${randomUUID()}`);
    const prevServerId = process.env.ROUTECODEX_SERVER_ID;
    process.env.ROUTECODEX_SERVER_ID = 'server-a:10000';
    const governorA = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'deepseek-web.berg',
      providerId: 'deepseek-web',
      providerFamily: 'deepseek-web',
      concurrency: { maxInFlight: 1, acquireTimeoutMs: 250, staleLeaseMs: 60000 },
      rpm: { requestsPerMinute: 100, acquireTimeoutMs: 250 }
    });
    try {
      const first = await governorA.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'deepseek-web.berg.deepseek-v4-pro',
        requestId: 'cross-a',
        runtime
      });
      process.env.ROUTECODEX_SERVER_ID = 'server-b:10001';
      const governorB = new ProviderTrafficGovernor(rootDir);
      await expect(governorB.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'deepseek-web.berg.deepseek-v4-pro',
        requestId: 'cross-b',
        runtime
      })).rejects.toBeInstanceOf(ProviderTrafficSaturatedError);
      await governorA.release(first.permit);
    } finally {
      if (typeof prevServerId === 'string') process.env.ROUTECODEX_SERVER_ID = prevServerId; else delete process.env.ROUTECODEX_SERVER_ID;
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('enforces concurrency and releases slots', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-${process.pid}-${randomUUID()}`);
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'qwenchat.1',
      providerId: 'qwenchat',
      providerFamily: 'qwenchat',
      concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 150,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 100,
        acquireTimeoutMs: 150
      }
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'qwenchat.1.qwen3.6-plus',
        requestId: 'req-1',
        runtime
      });
      await expect(
        governor.acquire({
          runtimeKey: runtime.runtimeKey,
          providerKey: 'qwenchat.1.qwen3.6-plus',
          requestId: 'req-2',
          runtime
        })
      ).rejects.toBeInstanceOf(ProviderTrafficSaturatedError);

      await governor.release(first.permit);

      const second = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'qwenchat.1.qwen3.6-plus',
        requestId: 'req-3',
        runtime
      });
      expect(second.activeInFlight).toBe(1);
      await governor.release(second.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('clears busy state once in-flight drops below maxInFlight', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-busy-clear-${process.pid}-${randomUUID()}`);
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'demo.alias',
      providerId: 'demo',
      providerFamily: 'demo',
      concurrency: {
        maxInFlight: 2,
        acquireTimeoutMs: 300,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 100,
        acquireTimeoutMs: 300
      }
    });
    const events: Array<{ scopeKey: string; busy: boolean }> = [];
    governor.setConcurrencyBusyCallback?.((scopeKey, busy) => {
      events.push({ scopeKey, busy });
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'demo.alias.model-a',
        requestId: 'busy-clear-1',
        runtime
      });
      const second = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'demo.alias.model-b',
        requestId: 'busy-clear-2',
        runtime
      });

      expect(events.some((event) => event.busy === true && event.scopeKey === 'demo.alias')).toBe(true);

      await governor.release(second.permit);

      expect(events.some((event) => event.busy === false && event.scopeKey === 'demo.alias')).toBe(true);

      await governor.release(first.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('resetCurrentProcessState releases stale local leases without process restart', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-reset-${process.pid}-${randomUUID()}`);
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'qwenchat.reset',
      providerId: 'qwenchat',
      providerFamily: 'qwenchat',
      concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 150,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 100,
        acquireTimeoutMs: 150
      }
    });
    try {
      await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'qwenchat.1.qwen3.6-plus',
        requestId: 'reset-req-1',
        runtime
      });

      await expect(
        governor.acquire({
          runtimeKey: runtime.runtimeKey,
          providerKey: 'qwenchat.1.qwen3.6-plus',
          requestId: 'reset-req-2',
          runtime
        })
      ).rejects.toBeInstanceOf(ProviderTrafficSaturatedError);

      const resetResult = await governor.resetCurrentProcessState();
      expect(resetResult.leasesRemoved).toBeGreaterThanOrEqual(1);

      const afterReset = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'qwenchat.1.qwen3.6-plus',
        requestId: 'reset-req-3',
        runtime
      });
      expect(afterReset.activeInFlight).toBe(1);
      await governor.release(afterReset.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('enforces rpm window', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-rpm-${process.pid}-${randomUUID()}`);
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'openrouter.key1',
      providerId: 'openrouter',
      providerFamily: 'openrouter',
      concurrency: {
        maxInFlight: 3,
        acquireTimeoutMs: 200,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 1,
        acquireTimeoutMs: 120
      }
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'openrouter.key1.qwen',
        requestId: 'rpm-1',
        runtime
      });
      await governor.release(first.permit);

      await expect(
        governor.acquire({
          runtimeKey: runtime.runtimeKey,
          providerKey: 'openrouter.key1.qwen',
          requestId: 'rpm-2',
          runtime
        })
      ).rejects.toBeInstanceOf(ProviderTrafficSaturatedError);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('raises saturation immediately when concurrency remains full', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-unified-${process.pid}-${randomUUID()}`);
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'weighted.pool',
      providerId: 'openrouter',
      providerFamily: 'openrouter',
      concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 30000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 100,
        acquireTimeoutMs: 30000
      }
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'openrouter.key1.qwen',
        requestId: 'soft-1',
        runtime
      });

      const startedAt = Date.now();
      await expect(
        governor.acquire({
          runtimeKey: runtime.runtimeKey,
          providerKey: 'openrouter.key1.qwen',
          requestId: 'soft-2',
          runtime
        })
      ).rejects.toMatchObject({
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        details: expect.objectContaining({
          reason: 'acquire_concurrency'
        })
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(1000);

      await governor.release(first.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('adaptive concurrency scales down when 429 average trend rises', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-down-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'adaptive', 'dynamic-concurrency-overrides.json');
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptiveConfigPath;
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'adaptive.down.runtime',
      providerId: 'tabglm',
      providerFamily: 'tabglm',
      concurrency: {
        maxInFlight: 4,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 240,
        acquireTimeoutMs: 6000
      }
    });
    const providerKey = 'tabglm.key1.glm-5.1';
    const startMs = Date.now();
    try {
      for (let minute = 0; minute < 10; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey: runtime.runtimeKey,
          providerKey,
          requestId: `down-${minute}`,
          success: minute < 5,
          statusCode: minute < 5 ? 200 : 429,
          activeInFlight: minute < 5 ? 2 : 4,
          configuredMaxInFlight: 4,
          observedAtMs: startMs + minute * 60_000
        });
      }
      const acquired = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey,
        requestId: 'down-check',
        runtime
      });
      expect(acquired.policy.concurrency.maxInFlight).toBeLessThan(4);
      await governor.release(acquired.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('adaptive concurrency persists inside the current run root by default', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-root-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'dynamic-concurrency-overrides.json');
    const runtimeKey = 'adaptive.root.runtime';
    const providerKey = 'ali-coding-plan.key1.glm-5';
    const runtime = createRuntime({
      runtimeKey,
      providerId: 'ali-coding-plan',
      providerFamily: 'ali-coding-plan',
      concurrency: {
        maxInFlight: 2,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 240,
        acquireTimeoutMs: 6000
      }
    });
    try {
      const governor = new ProviderTrafficGovernor(rootDir);
      const startMs = Date.now();
      for (let minute = 0; minute < 6; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey,
          providerKey,
          requestId: `root-${minute}`,
          success: true,
          statusCode: 200,
          activeInFlight: 2,
          configuredMaxInFlight: 2,
          observedAtMs: startMs + minute * 60_000
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 650));
      const persistedRaw = await fs.readFile(adaptiveConfigPath, 'utf8');
      const persisted = JSON.parse(persistedRaw) as {
        runtimes?: Record<string, { currentCap?: number }>;
      };
      expect((persisted.runtimes?.[runtimeKey]?.currentCap ?? 0)).toBeGreaterThanOrEqual(3);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('adaptive concurrency scales down conservatively under sustained 429 pressure', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-conservative-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'adaptive', 'dynamic-concurrency-overrides.json');
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptiveConfigPath;
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'adaptive.conservative.runtime',
      providerId: 'ali-coding-plan',
      providerFamily: 'ali-coding-plan',
      concurrency: {
        maxInFlight: 6,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 360,
        acquireTimeoutMs: 6000
      }
    });
    const providerKey = 'ali-coding-plan.key1.qwen3.6-plus';
    const startMs = Date.now();
    try {
      for (let minute = 0; minute < 10; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey: runtime.runtimeKey,
          providerKey,
          requestId: `conservative-${minute}`,
          success: false,
          statusCode: 429,
          activeInFlight: 6,
          configuredMaxInFlight: 6,
          observedAtMs: startMs + minute * 60_000
        });
      }

      const acquired = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey,
        requestId: 'conservative-check',
        runtime
      });
      expect(acquired.policy.concurrency.maxInFlight).toBe(4);
      await governor.release(acquired.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('adaptive concurrency can recover upward toward safe cap after a cooled-down 429 window', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-recover-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'adaptive', 'dynamic-concurrency-overrides.json');
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptiveConfigPath;
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'adaptive.recover.runtime',
      providerId: 'ali-coding-plan',
      providerFamily: 'ali-coding-plan',
      concurrency: {
        maxInFlight: 6,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 360,
        acquireTimeoutMs: 6000
      }
    });
    const providerKey = 'ali-coding-plan.key1.qwen3.6-plus';
    const startMs = Date.now();
    try {
      for (let minute = 0; minute < 10; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey: runtime.runtimeKey,
          providerKey,
          requestId: `recover-down-${minute}`,
          success: false,
          statusCode: 429,
          activeInFlight: 6,
          configuredMaxInFlight: 6,
          observedAtMs: startMs + minute * 60_000
        });
      }

      const afterDown = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey,
        requestId: 'recover-down-check',
        runtime
      });
      expect(afterDown.policy.concurrency.maxInFlight).toBe(4);
      await governor.release(afterDown.permit);

      const recoveryStartMs = startMs + 26 * 60_000;
      for (let minute = 0; minute < 4; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey: runtime.runtimeKey,
          providerKey,
          requestId: `recover-up-${minute}`,
          success: true,
          statusCode: 200,
          activeInFlight: 6,
          configuredMaxInFlight: 6,
          observedAtMs: recoveryStartMs + minute * 60_000
        });
      }

      const afterRecovery = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey,
        requestId: 'recover-up-check',
        runtime
      });
      expect(afterRecovery.policy.concurrency.maxInFlight).toBeGreaterThanOrEqual(5);
      expect(afterRecovery.policy.concurrency.maxInFlight).toBeLessThanOrEqual(6);
      await governor.release(afterRecovery.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });


  it('forces web providers to concurrency 1 even when runtime config asks for higher concurrency', () => {
    const deepseekWebPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        runtimeKey: 'deepseek-web.2',
        providerId: 'deepseek-web',
        providerFamily: 'deepseek-web',
        compatibilityProfile: 'chat:deepseek-web',
        concurrency: {
          maxInFlight: 3,
          acquireTimeoutMs: 12000,
          staleLeaseMs: 150000
        },
        rpm: {
          requestsPerMinute: 77,
          acquireTimeoutMs: 23000
        }
      }),
      'deepseek-web.2.deepseek-v4-pro'
    );
    expect(deepseekWebPolicy.concurrency).toEqual({
      maxInFlight: 1,
      acquireTimeoutMs: 12000,
      staleLeaseMs: 150000
    });
    expect(deepseekWebPolicy.rpm.requestsPerMinute).toBe(77);

    const qwenChatWebPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        runtimeKey: 'qwenchat.1',
        providerId: 'qwenchat',
        providerFamily: 'qwenchat',
        endpoint: 'https://chat.qwen.ai/api',
        concurrency: {
          maxInFlight: 4,
          acquireTimeoutMs: 9000,
          staleLeaseMs: 160000
        }
      }),
      'qwenchat.1.qwen3.6-plus'
    );
    expect(qwenChatWebPolicy.concurrency.maxInFlight).toBe(1);
  });

  it('disables adaptive concurrency scale-up for web providers', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-web-adaptive-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'adaptive', 'dynamic-concurrency-overrides.json');
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptiveConfigPath;
    const runtimeKey = 'deepseek-web.adaptive.runtime';
    const providerKey = 'deepseek-web.2.deepseek-v4-pro';
    const runtime = createRuntime({
      runtimeKey,
      providerId: 'deepseek-web',
      providerFamily: 'deepseek-web',
      compatibilityProfile: 'chat:deepseek-web',
      concurrency: {
        maxInFlight: 5,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 240,
        acquireTimeoutMs: 6000
      }
    });
    try {
      const governor = new ProviderTrafficGovernor(rootDir);
      const startMs = Date.now();
      for (let minute = 0; minute < 6; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey,
          providerKey,
          requestId: `web-up-${minute}`,
          success: true,
          statusCode: 200,
          activeInFlight: 1,
          configuredMaxInFlight: 1,
          observedAtMs: startMs + minute * 60_000
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 650));

      const acquired = await governor.acquire({
        runtimeKey,
        providerKey,
        requestId: 'web-up-check',
        runtime
      });
      expect(acquired.policy.concurrency.maxInFlight).toBe(1);
      await governor.release(acquired.permit);

      await expect(fs.readFile(adaptiveConfigPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('adaptive concurrency scales up on no-429 window and persists to config', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-adaptive-up-${process.pid}-${randomUUID()}`);
    const adaptiveConfigPath = path.join(rootDir, 'adaptive', 'dynamic-concurrency-overrides.json');
    process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = adaptiveConfigPath;
    const runtimeKey = 'adaptive.up.runtime';
    const providerKey = 'ali-coding-plan.key1.glm-5';
    const runtime = createRuntime({
      runtimeKey,
      providerId: 'ali-coding-plan',
      providerFamily: 'ali-coding-plan',
      concurrency: {
        maxInFlight: 2,
        acquireTimeoutMs: 6000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 240,
        acquireTimeoutMs: 6000
      }
    });
    try {
      const governor = new ProviderTrafficGovernor(rootDir);
      const startMs = Date.now();
      for (let minute = 0; minute < 6; minute += 1) {
        await governor.observeOutcome?.({
          runtimeKey,
          providerKey,
          requestId: `up-${minute}`,
          success: true,
          statusCode: 200,
          activeInFlight: 2,
          configuredMaxInFlight: 2,
          observedAtMs: startMs + minute * 60_000
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 650));

      const acquired = await governor.acquire({
        runtimeKey,
        providerKey,
        requestId: 'up-check',
        runtime
      });
      expect(acquired.policy.concurrency.maxInFlight).toBeGreaterThanOrEqual(3);
      await governor.release(acquired.permit);

      const persistedRaw = await fs.readFile(adaptiveConfigPath, 'utf8');
      const persisted = JSON.parse(persistedRaw) as {
        runtimes?: Record<string, { currentCap?: number }>;
      };
      expect((persisted.runtimes?.[runtimeKey]?.currentCap ?? 0)).toBeGreaterThanOrEqual(3);

      const governorReloaded = new ProviderTrafficGovernor(rootDir);
      const acquiredReloaded = await governorReloaded.acquire({
        runtimeKey,
        providerKey,
        requestId: 'up-check-reload',
        runtime
      });
      expect(acquiredReloaded.policy.concurrency.maxInFlight).toBeGreaterThanOrEqual(3);
      await governorReloaded.release(acquiredReloaded.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
