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
  it('applies provider tier defaults for concurrency and rpm', () => {
    const deepseekPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'deepseek',
        providerFamily: 'deepseek',
        runtimeKey: 'deepseek.alias'
      }),
      'deepseek.alias.deepseek-chat'
    );
    expect(deepseekPolicy.concurrency.maxInFlight).toBe(1);
    expect(deepseekPolicy.rpm.requestsPerMinute).toBe(60);

    const tabglmPolicy = resolveProviderTrafficPolicy(
      createRuntime({
        providerId: 'tabglm',
        providerFamily: 'tabglm',
        runtimeKey: 'tabglm.key1'
      }),
      'tabglm.key1.glm-5.1'
    );
    expect(tabglmPolicy.concurrency.maxInFlight).toBe(4);
    expect(tabglmPolicy.rpm.requestsPerMinute).toBe(240);

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
    expect(crsPolicy.concurrency.maxInFlight).toBe(4);
    expect(crsPolicy.rpm.requestsPerMinute).toBe(240);
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
});
