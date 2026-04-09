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
  const originalMaxWaiters = process.env.ROUTECODEX_PROVIDER_TRAFFIC_MAX_WAITERS;

  afterEach(() => {
    if (typeof originalAdaptivePath === 'string') {
      process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH = originalAdaptivePath;
    } else {
      delete process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH;
    }
    if (typeof originalMaxWaiters === 'string') {
      process.env.ROUTECODEX_PROVIDER_TRAFFIC_MAX_WAITERS = originalMaxWaiters;
    } else {
      delete process.env.ROUTECODEX_PROVIDER_TRAFFIC_MAX_WAITERS;
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

  it('honors explicit runtime overrides for concurrency and rpm', () => {
    const policy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'qwenchat',
        providerFamily: 'qwenchat',
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
      'qwenchat.1.qwen3.6-plus'
    );
    expect(policy.concurrency).toEqual({
      maxInFlight: 3,
      acquireTimeoutMs: 12000,
      staleLeaseMs: 150000
    });
    expect(policy.rpm.requestsPerMinute).toBe(77);
    expect(policy.rpm.acquireTimeoutMs).toBe(23000);
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

  it('supports soft wait timeout to trigger fast provider switch', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-soft-${process.pid}-${randomUUID()}`);
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
          runtime,
          softWaitTimeoutMs: 120
        })
      ).rejects.toBeInstanceOf(ProviderTrafficSaturatedError);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(1500);

      await governor.release(first.permit);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('bounds blocked acquire waiters to avoid queue blow-up', async () => {
    const rootDir = path.join(os.tmpdir(), `provider-traffic-governor-waiters-${process.pid}-${randomUUID()}`);
    process.env.ROUTECODEX_PROVIDER_TRAFFIC_MAX_WAITERS = '1';
    const governor = new ProviderTrafficGovernor(rootDir);
    const runtime = createRuntime({
      runtimeKey: 'waiter.bound.runtime',
      providerId: 'ali-coding-plan',
      providerFamily: 'ali-coding-plan',
      concurrency: {
        maxInFlight: 1,
        acquireTimeoutMs: 2000,
        staleLeaseMs: 60000
      },
      rpm: {
        requestsPerMinute: 100,
        acquireTimeoutMs: 2000
      }
    });
    try {
      const first = await governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'ali-coding-plan.key1.glm-5',
        requestId: 'waiter-1',
        runtime
      });

      const second = governor.acquire({
        runtimeKey: runtime.runtimeKey,
        providerKey: 'ali-coding-plan.key1.glm-5',
        requestId: 'waiter-2',
        runtime
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      await expect(
        governor.acquire({
          runtimeKey: runtime.runtimeKey,
          providerKey: 'ali-coding-plan.key1.glm-5',
          requestId: 'waiter-3',
          runtime
        })
      ).rejects.toMatchObject({
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        details: expect.objectContaining({
          reason: 'acquire_waiter_overload'
        })
      });

      await governor.release(first.permit);
      const secondPermit = await second;
      expect(secondPermit.activeInFlight).toBe(1);
      await governor.release(secondPermit.permit);
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
          activeInFlight: 4,
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
