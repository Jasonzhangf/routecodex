import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let ProviderQuotaDaemonModule: typeof import('../../../src/manager/modules/quota/index.js').ProviderQuotaDaemonModule;
let createInitialQuotaState: typeof import('../../../src/manager/quota/provider-quota-center.js').createInitialQuotaState;

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return () => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  };
}


async function emitProviderError(mod: InstanceType<typeof ProviderQuotaDaemonModule>, event: any): Promise<void> {
  await (mod as any).handleProviderErrorEvent(event);
}
describe('ProviderQuotaDaemonModule', () => {
  let tempQuotaDir: string | null = null;
  let restoreQuotaDir: (() => void) | null = null;
  let restorePersistDebounce: (() => void) | null = null;
  let restoreInterval: (() => void) | null = null;

  beforeAll(async () => {
    ({ ProviderQuotaDaemonModule } = await import('../../../src/manager/modules/quota/index.js'));
    ({ createInitialQuotaState } = await import('../../../src/manager/quota/provider-quota-center.js'));
  });

  beforeEach(async () => {
    tempQuotaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-daemon-test-'));
    restoreQuotaDir = setEnv('ROUTECODEX_QUOTA_DIR', tempQuotaDir);
    restorePersistDebounce = setEnv('ROUTECODEX_QUOTA_PERSIST_DEBOUNCE_MS', '1');
    restoreInterval = setEnv('ROUTECODEX_QUOTA_DAEMON_INTERVAL_MS', '99999999');
  });

  afterEach(async () => {
    restoreQuotaDir?.();
    restorePersistDebounce?.();
    restoreInterval?.();
    if (tempQuotaDir) {
      try {
        await fs.rm(tempQuotaDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempQuotaDir = null;
    restoreQuotaDir = null;
    restorePersistDebounce = null;
    restoreInterval = null;
    jest.useRealTimers();
  });

  it('applies deterministic quota reset delay for antigravity 429 and recovers after cooldown', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_429',
      message: 'HTTP 429: {"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 1s."}}',
      stage: 'provider.provider.http',
      status: 429,
      recoverable: true,
      timestamp: now,
      runtime: {
        requestId: 'req_test',
        providerKey: 'antigravity.alias1.gemini-3-pro-high',
        providerId: 'antigravity'
      },
      details: {}
    } as any);

    // Allow async handler to run and the persist debounce to flush.
    await jest.advanceTimersByTimeAsync(5);

    const snapshot1 = mod.getAdminSnapshot();
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high']).toBeDefined();
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].inPool).toBe(true);
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].reason).toBe('cooldown');
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].cooldownUntil).toBe(now + 3_000);

    await jest.advanceTimersByTimeAsync(1_100);
    const quotaView = mod.getQuotaView();
    expect(quotaView).not.toBeNull();
    const entry = quotaView!('antigravity.alias1.gemini-3-pro-high');
    expect(entry?.inPool).toBe(true);

    await mod.stop();
  });

  it('keeps provider in pool for early recoverable 500 cooldown steps', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-13T21:25:51.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_500',
      message: 'Internal Server Error',
      stage: 'provider.send',
      status: 500,
      recoverable: true,
      affectsHealth: false,
      timestamp: now,
      runtime: {
        requestId: 'req_test_500',
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        providerId: 'mimo'
      },
      details: {
        errorClassification: 'recoverable',
        errorCode: 'HTTP_500',
        upstreamCode: 'HTTP_500',
        reason: 'Internal Server Error',
        attempt: 1
      }
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot['mimo.key1.mimo-v2.5-pro']).toBeDefined();
    expect(snapshot['mimo.key1.mimo-v2.5-pro'].reason).toBe('cooldown');
    expect(snapshot['mimo.key1.mimo-v2.5-pro'].inPool).toBe(true);
    expect(snapshot['mimo.key1.mimo-v2.5-pro'].cooldownUntil).toBe(now + 3_000);

    const quotaView = mod.getQuotaView();
    expect(quotaView).not.toBeNull();
    expect(quotaView!('mimo.key1.mimo-v2.5-pro')?.inPool).toBe(true);

    await mod.stop();
  });

  it('single-provider recoverable 502 burst stays in pool (backoff only, no eviction)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:00:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    for (let i = 0; i < 4; i += 1) {
      const ts = baseNow + i * 2_000;
      await emitProviderError(mod, {
        code: 'HTTP_502',
        message: 'Upstream SSE error event: Internal Network Failure',
        stage: 'provider.send',
        status: 502,
        recoverable: true,
        affectsHealth: false,
        timestamp: ts,
        runtime: {
          requestId: `req_single_502_${i}`,
          providerKey,
          providerId: 'mini27'
        },
        details: {
          errorClassification: 'recoverable',
          errorCode: 'HTTP_502',
          upstreamCode: 'HTTP_502',
          reason: 'Internal Network Failure',
          attempt: i + 1,
          routePoolSize: 1
        }
      } as any);
      await jest.advanceTimersByTimeAsync(5);
    }

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownUntil).toBeGreaterThan(baseNow);
    expect(snapshot[providerKey].consecutiveErrorCount).toBeGreaterThanOrEqual(1);

    const quotaView = mod.getQuotaView();
    expect(quotaView).not.toBeNull();
    expect(quotaView!(providerKey)?.inPool).toBe(true);

    await mod.stop();
  });

  it('single provider_status_1000 520 wrapper stays in pool and only records transient backoff', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-23T22:11:24.000Z'));
    const now = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'MALFORMED_RESPONSE',
      message: '[hub_response] upstream returned unknown error, 520',
      stage: 'chat_process.response.entry',
      status: 520,
      recoverable: true,
      affectsHealth: false,
      timestamp: now,
      runtime: {
        requestId: 'req_provider_status_1000_520',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'recoverable',
        errorCode: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_1000',
        reason: 'unknown error, 520',
        routePoolSize: 1
      }
    } as any);
    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(1);

    const quotaView = mod.getQuotaView();
    expect(quotaView(providerKey)?.inPool).toBe(true);

    await mod.stop();
  });

  it('unknown route pool repeated 5xx stays in pool as last-provider backoff', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:03:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    for (let i = 0; i < 4; i += 1) {
      const ts = baseNow + i * 2_000;
      await emitProviderError(mod, {
        code: 'EXTERNAL_ERROR',
        message: 'provider temporary failure',
        stage: 'provider.send',
        status: 502,
        recoverable: false,
        affectsHealth: true,
        timestamp: ts,
        runtime: {
          requestId: `req_unknown_pool_5xx_${i}`,
          providerKey,
          providerId: 'mini27'
        },
        details: {
          errorClassification: 'unrecoverable',
          errorCode: 'EXTERNAL_ERROR',
          upstreamCode: 'provider_status_2056',
          reason: 'temporary_provider_error'
        }
      } as any);
      await jest.advanceTimersByTimeAsync(5);
    }

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBeGreaterThanOrEqual(3);

    const quotaView = mod.getQuotaView();
    expect(quotaView(providerKey)?.inPool).toBe(true);
    expect((quotaView(providerKey) as any)?.cooldownKeepsPool).toBe(true);

    await mod.stop();
  });

  it('last provider already evicted by 5xx is restored to pool for backoff-only retry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:04:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    (mod as any).quotaStates.set(providerKey, {
      ...createInitialQuotaState(providerKey, { authType: 'apikey' }, baseNow - 10_000),
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: baseNow + 60_000,
      cooldownKeepsPool: undefined,
      lastErrorSeries: 'E5XX',
      lastErrorCode: 'HTTP_502',
      lastErrorAtMs: baseNow - 1_000,
      consecutiveErrorCount: 3
    });

    await emitProviderError(mod, {
      code: 'HTTP_502',
      message: 'provider temporary failure',
      stage: 'provider.send',
      status: 502,
      recoverable: true,
      affectsHealth: true,
      timestamp: baseNow,
      runtime: {
        requestId: 'req_last_provider_restore_from_evicted_5xx',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'unrecoverable',
        errorCode: 'HTTP_502',
        upstreamCode: 'provider_status_2056',
        reason: 'temporary_provider_error',
        routePoolSize: 1
      }
    } as any);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBeGreaterThanOrEqual(3);

    await mod.stop();
  });

  it('single-provider unrecoverable 3x still does not evict (no alternate route)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:05:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    for (let i = 0; i < 3; i += 1) {
      const ts = baseNow + i * 1_000;
      await emitProviderError(mod, {
        code: 'HTTP_401',
        message: 'Invalid API key',
        stage: 'provider.send',
        status: 401,
        recoverable: false,
        affectsHealth: true,
        timestamp: ts,
        runtime: {
          requestId: `req_single_unrecoverable_${i}`,
          providerKey,
          providerId: 'mini27'
        },
        details: {
          errorClassification: 'unrecoverable',
          errorCode: 'HTTP_401',
          upstreamCode: 'HTTP_401',
          reason: 'invalid_api_key',
          attempt: i + 1,
          routePoolSize: 1
        }
      } as any);
      await jest.advanceTimersByTimeAsync(5);
    }

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(3);

    await mod.stop();
  });

  it('resets consecutive provider errors after an intervening success event', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:08:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'MALFORMED_RESPONSE',
      message: 'provider business error',
      stage: 'provider.send',
      status: 502,
      recoverable: false,
      affectsHealth: true,
      timestamp: baseNow,
      runtime: {
        requestId: 'req_non_continuous_error_1',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'unrecoverable',
        upstreamCode: 'provider_status_2056',
        routePoolSize: 2
      }
    } as any);

    (mod as any).onProviderSuccess({
      runtime: { providerKey },
      usage: { totalTokens: 10 },
      timestamp: baseNow + 1_000
    });

    await emitProviderError(mod, {
      code: 'MALFORMED_RESPONSE',
      message: 'provider business error',
      stage: 'provider.send',
      status: 502,
      recoverable: false,
      affectsHealth: true,
      timestamp: baseNow + 2_000,
      runtime: {
        requestId: 'req_non_continuous_error_2',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'unrecoverable',
        upstreamCode: 'provider_status_2056',
        routePoolSize: 2
      }
    } as any);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(1);
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);

    await mod.stop();
  });

  it('resets consecutive provider errors through the quota adapter success hook', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:09:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';
    const { createQuotaManagerAdapter } = await import('../../../src/manager/modules/quota/quota-adapter.js');

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();
    const adapter = createQuotaManagerAdapter({ coreManager: null, legacyDaemon: mod as any });

    await emitProviderError(mod, {
      code: 'MALFORMED_RESPONSE',
      message: 'provider business error',
      stage: 'provider.send',
      status: 502,
      recoverable: false,
      affectsHealth: true,
      timestamp: baseNow,
      runtime: {
        requestId: 'req_adapter_non_continuous_error_1',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'unrecoverable',
        upstreamCode: 'provider_status_2056',
        routePoolSize: 2
      }
    } as any);

    adapter.onProviderSuccess({
      runtime: { requestId: 'req_adapter_success', providerKey },
      timestamp: baseNow + 1_000,
      details: { totalTokens: 10 }
    } as any);

    await emitProviderError(mod, {
      code: 'MALFORMED_RESPONSE',
      message: 'provider business error',
      stage: 'provider.send',
      status: 502,
      recoverable: false,
      affectsHealth: true,
      timestamp: baseNow + 2_000,
      runtime: {
        requestId: 'req_adapter_non_continuous_error_2',
        providerKey,
        providerId: 'mini27'
      },
      details: {
        errorClassification: 'unrecoverable',
        upstreamCode: 'provider_status_2056',
        routePoolSize: 2
      }
    } as any);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(1);
    expect(snapshot[providerKey].inPool).toBe(true);

    await mod.stop();
  });

  it('unrecoverable 3x evicts only when alternate routes exist', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T20:10:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'mini27.key1.MiniMax-M2.7';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    for (let i = 0; i < 3; i += 1) {
      const ts = baseNow + i * 1_000;
      await emitProviderError(mod, {
        code: 'HTTP_401',
        message: 'Invalid API key',
        stage: 'provider.send',
        status: 401,
        recoverable: false,
        affectsHealth: true,
        timestamp: ts,
        runtime: {
          requestId: `req_multi_unrecoverable_${i}`,
          providerKey,
          providerId: 'mini27'
        },
        details: {
          errorClassification: 'unrecoverable',
          errorCode: 'HTTP_401',
          upstreamCode: 'HTTP_401',
          reason: 'invalid_api_key',
          attempt: i + 1,
          routePoolSize: 2
        }
      } as any);
      await jest.advanceTimersByTimeAsync(5);
    }

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(3);

    await mod.stop();
  });

  it('canonicalizes legacy sequence-prefixed antigravity alias keys (1-foo -> foo)', async () => {
    const now = Date.now();
    const legacyKey = 'antigravity.1-geetasamodgeetasamoda.claude-sonnet-4-5-thinking';
    const canonicalKey = 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking';

    const legacyState = {
      ...createInitialQuotaState(legacyKey, { authType: 'oauth' }, now),
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: now + 60_000,
      consecutiveErrorCount: 3,
      lastErrorSeries: 'E429'
    } as any;

    const canonicalState = {
      ...createInitialQuotaState(canonicalKey, { authType: 'oauth' }, now),
      inPool: true,
      reason: 'ok',
      cooldownUntil: null,
      consecutiveErrorCount: 0,
      lastErrorSeries: null
    } as any;

    const filePath = path.join(tempQuotaDir!, 'provider-quota.json');
    await fs.writeFile(
      filePath,
      `${JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), providers: { [legacyKey]: legacyState, [canonicalKey]: canonicalState } }, null, 2)}\n`,
      'utf8'
    );

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });

    const admin = mod.getAdminSnapshot();
    expect(admin[legacyKey]).toBeUndefined();
    expect(admin[canonicalKey]).toBeDefined();
    expect(admin[canonicalKey].inPool).toBe(false);
    expect(admin[canonicalKey].reason).toBe('cooldown');
    expect(admin[canonicalKey].cooldownUntil).toBe(now + 60_000);

    const view = mod.getQuotaView();
    expect(view).not.toBeNull();
    const viaLegacy = view!(legacyKey);
    const viaCanonical = view!(canonicalKey);
    expect(viaLegacy?.providerKey).toBe(canonicalKey);
    expect(viaCanonical?.providerKey).toBe(canonicalKey);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted.providers[legacyKey]).toBeUndefined();
    expect(persisted.providers[canonicalKey]).toBeDefined();
  });

  it('cools down an antigravity alias for 30m on OAuth reauth-required 403 (rotate away from broken token)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-04T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('antigravity.alias1.gemini-3-pro-high', { authType: 'oauth' });
    mod.registerProviderStaticConfig('antigravity.alias1.claude-sonnet-4-5-thinking', { authType: 'oauth' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_403',
      message: 'HTTP 403: Please authenticate with Google OAuth first',
      stage: 'provider.provider.http',
      status: 403,
      recoverable: false,
      timestamp: now,
      runtime: {
        requestId: 'req_test_403_reauth',
        providerKey: 'antigravity.alias1.gemini-3-pro-high',
        providerId: 'antigravity'
      },
      details: {}
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot['antigravity.alias1.gemini-3-pro-high']).toBeDefined();
    expect(snapshot['antigravity.alias1.claude-sonnet-4-5-thinking']).toBeDefined();
    expect(snapshot['antigravity.alias1.gemini-3-pro-high'].inPool).toBe(true);
    expect(snapshot['antigravity.alias1.claude-sonnet-4-5-thinking'].inPool).toBe(true);
    expect(snapshot['antigravity.alias1.gemini-3-pro-high'].reason).toBe('cooldown');
    expect(snapshot['antigravity.alias1.claude-sonnet-4-5-thinking'].reason).toBe('ok');
    expect(snapshot['antigravity.alias1.gemini-3-pro-high'].cooldownUntil).toBe(now + 5 * 60_000);
    expect(snapshot['antigravity.alias1.claude-sonnet-4-5-thinking'].cooldownUntil).toBeNull();

    await mod.stop();
  });

  it('does not let QUOTA_RECOVERY override capacity cooldown windows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_429',
      message: 'HTTP 429: {"error":{"message":"No capacity available for model claude-sonnet-4-5-thinking on the server"}}',
      stage: 'provider.provider.http',
      status: 429,
      recoverable: false,
      timestamp: now,
      runtime: {
        requestId: 'req_test_capacity',
        providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
        providerId: 'antigravity'
      },
      details: {
        virtualRouterSeriesCooldown: {
          providerId: 'antigravity.alias1',
          providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
          series: 'claude',
          cooldownMs: 1000,
          expiresAt: now + 1000,
          source: 'capacity_exhausted_fallback'
        }
      }
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot1 = mod.getAdminSnapshot();
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking']).toBeDefined();
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].inPool).toBe(true);
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].reason).toBe('cooldown');
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].cooldownUntil).toBe(now + 15_000);

    await emitProviderError(mod, {
      code: 'QUOTA_RECOVERY',
      message: 'Quota manager: provider quota refreshed',
      stage: 'quota',
      status: 200,
      recoverable: true,
      timestamp: now + 10,
      runtime: {
        requestId: `quota_${now + 10}`,
        providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
        providerId: 'antigravity'
      },
      details: {
        virtualRouterQuotaRecovery: {
          providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
          reason: 'quota>0 for model claude-sonnet-4-5-thinking',
          source: 'quota-manager'
        }
      }
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot2 = mod.getAdminSnapshot();
    expect(snapshot2['antigravity.alias1.claude-sonnet-4-5-thinking'].inPool).toBe(true);
    expect(snapshot2['antigravity.alias1.claude-sonnet-4-5-thinking'].reason).toBe('cooldown');

    await jest.advanceTimersByTimeAsync(15_100);
    const view = mod.getQuotaView();
    const entry = view?.('antigravity.alias1.claude-sonnet-4-5-thinking');
    expect(entry?.inPool).toBe(true);

    await mod.stop();
  });

  it('recoverable 5xx 3x evicts when alternate routes exist instead of keeping a hot 502 provider in pool', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-23T18:55:00.000Z'));
    const baseNow = Date.now();
    const providerKey = 'windsurf.ws-pro-3.gpt-5.4-none';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    for (let i = 0; i < 3; i += 1) {
      const ts = baseNow + i * 1_000;
      await emitProviderError(mod, {
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        message: 'The pending stream has been canceled',
        stage: 'provider.send',
        status: 502,
        recoverable: true,
        affectsHealth: true,
        timestamp: ts,
        runtime: {
          requestId: `req_ws_502_${i}`,
          providerKey,
          providerId: 'windsurf'
        },
        details: {
          errorClassification: 'recoverable',
          errorCode: 'WINDSURF_UPSTREAM_TRANSIENT',
          upstreamCode: 'WINDSURF_UPSTREAM_TRANSIENT',
          reason: 'pending_stream_canceled',
          attempt: i + 1,
          routePoolSize: 3
        }
      } as any);
      await jest.advanceTimersByTimeAsync(5);
    }

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey]).toBeDefined();
    expect(snapshot[providerKey].reason).toBe('cooldown');
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(3);

    const cooldownUntil = snapshot[providerKey].cooldownUntil as number;
    jest.setSystemTime(cooldownUntil + 1);
    const quotaView = mod.getQuotaView();
    const entryAfterExpiry = quotaView(providerKey);
    expect(entryAfterExpiry?.inPool).toBe(true);
    expect(entryAfterExpiry?.reason).toBe('ok');
    expect(entryAfterExpiry?.cooldownUntil).toBeNull();
    expect(entryAfterExpiry?.consecutiveErrorCount).toBe(0);

    await mod.stop();
  });

  it('keeps antigravity oauth providers available by default and preserves availability on quota recovery signal', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('antigravity.alias1.claude-sonnet-4-5-thinking', { authType: 'oauth' });
    await mod.start();

    const view1 = mod.getQuotaView();
    expect(view1).not.toBeNull();
    expect(view1!('antigravity.alias1.claude-sonnet-4-5-thinking')?.inPool).toBe(true);

    await emitProviderError(mod, {
      code: 'QUOTA_RECOVERY',
      message: 'Quota manager: provider quota refreshed',
      stage: 'quota',
      status: 200,
      recoverable: true,
      timestamp: now,
      runtime: {
        requestId: `quota_${now}`,
        providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
        providerId: 'antigravity'
      },
      details: {
        virtualRouterQuotaRecovery: {
          providerKey: 'antigravity.alias1.claude-sonnet-4-5-thinking',
          reason: 'quota>0 for model claude-sonnet-4-5-thinking',
          source: 'quota-manager'
        }
      }
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const view2 = mod.getQuotaView();
    expect(view2!('antigravity.alias1.claude-sonnet-4-5-thinking')?.inPool).toBe(true);

    await mod.stop();
  });

  it('tracks 429 backoff for apikey providers (no automatic blacklist)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    // seed static config so series policy uses apikey rules
    mod.registerProviderStaticConfig('tab.default.gpt-5.1', { authType: 'apikey' });
    await mod.start();

    const baseNow = Date.now();
    for (let i = 0; i < 3; i++) {
      await emitProviderError(mod, {
        code: 'HTTP_429',
        message: 'HTTP 429: rate limited',
        stage: 'provider.provider.http',
        status: 429,
        recoverable: false,
        timestamp: baseNow + i * 1000,
        runtime: {
          requestId: `req_${i}`,
          providerKey: 'tab.default.gpt-5.1',
          providerId: 'tab'
        },
        details: {}
      } as any);
    }

    await jest.advanceTimersByTimeAsync(10);
    const snapshot = mod.getAdminSnapshot();
    const state = snapshot['tab.default.gpt-5.1'];
    expect(state).toBeDefined();
    expect(state.inPool).toBe(true);
    expect(state.reason).toBe('cooldown');
    expect(state.blacklistUntil).toBeNull();
    expect(state.cooldownUntil).toBe(baseNow + 2_000 + 31_000);

    await jest.advanceTimersByTimeAsync(31_000 + 2_000 + 5);
    const view = mod.getQuotaView();
    const entry = view?.('tab.default.gpt-5.1');
    expect(entry?.inPool).toBe(true);

    await mod.stop();
  });

  it('does not wrap model capacity cooldown schedules (no 9s/15s/27s loop)', async () => {
    const prev = process.env.ROUTECODEX_MODEL_CAPACITY_SCHEDULE;
    process.env.ROUTECODEX_MODEL_CAPACITY_SCHEDULE = '9s,15s,27s';
    try {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));

      const mod = new ProviderQuotaDaemonModule();
      await mod.init({ serverId: 'test' });
      mod.registerProviderStaticConfig('tab.default.gpt-5.1', { authType: 'apikey' });
      await mod.start();

        const baseNow = Date.now();
      for (let i = 0; i < 4; i += 1) {
        await emitProviderError(mod, {
          code: 'HTTP_429',
          message: 'HTTP 429: MODEL_CAPACITY_EXHAUSTED',
          stage: 'provider.provider.http',
          status: 429,
          recoverable: true,
          timestamp: baseNow + i * 1000,
          runtime: {
            requestId: `req_capacity_${i}`,
            providerKey: 'tab.default.gpt-5.1',
            providerId: 'tab'
          },
          details: {}
        } as any);
      }

      await jest.advanceTimersByTimeAsync(10);
      const snapshot = mod.getAdminSnapshot();
      const state = snapshot['tab.default.gpt-5.1'];
      expect(state).toBeDefined();
      // 4th event must clamp to the last schedule step (27s), not wrap back to 9s.
      expect(state.cooldownUntil).toBe(baseNow + 3 * 1000 + 27_000);

      await mod.stop();
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_MODEL_CAPACITY_SCHEDULE;
      } else {
        process.env.ROUTECODEX_MODEL_CAPACITY_SCHEDULE = prev;
      }
    }
  });

  it('caps repeated 429 backoff at 61s and keeps capped step within chain window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('tab.default.gpt-5.1', { authType: 'apikey' });
    await mod.start();

    const baseNow = Date.now();
    const eventCount = 7; // reaches the last step in the schedule
    for (let i = 0; i < eventCount; i++) {
      await emitProviderError(mod, {
        code: 'HTTP_429',
        message: 'HTTP 429: rate limited',
        stage: 'provider.provider.http',
        status: 429,
        recoverable: false,
        timestamp: baseNow + i * 1000,
        runtime: {
          requestId: `req_${i}`,
          providerKey: 'tab.default.gpt-5.1',
          providerId: 'tab'
        },
        details: {}
      } as any);
    }

    await jest.advanceTimersByTimeAsync(10);
    const snapshot = mod.getAdminSnapshot();
    const state = snapshot['tab.default.gpt-5.1'];
    expect(state).toBeDefined();
    expect(state.inPool).toBe(true);
    expect(state.reason).toBe('cooldown');
    expect(state.blacklistUntil).toBeNull();
    expect(state.cooldownUntil).toBe(baseNow + (eventCount - 1) * 1000 + 61_000);

    // After cooldown expiry, it should re-enter the pool.
    await jest.advanceTimersByTimeAsync(61_000 + (eventCount - 1) * 1000 + 5);
    const view = mod.getQuotaView();
    const entry = view?.('tab.default.gpt-5.1');
    expect(entry?.inPool).toBe(true);

    // Next 429 within the chain window stays at capped step.
    const afterCooldownNow = Date.now();
    await emitProviderError(mod, {
      code: 'HTTP_429',
      message: 'HTTP 429: rate limited',
      stage: 'provider.provider.http',
      status: 429,
      recoverable: false,
      timestamp: afterCooldownNow,
      runtime: {
        requestId: 'req_after_cooldown',
        providerKey: 'tab.default.gpt-5.1',
        providerId: 'tab'
      },
      details: {}
    } as any);
    await jest.advanceTimersByTimeAsync(5);
    const snap2 = mod.getAdminSnapshot();
    expect(snap2['tab.default.gpt-5.1'].reason).toBe('cooldown');
    expect(snap2['tab.default.gpt-5.1'].cooldownUntil).toBe(afterCooldownNow + 61_000);

    await mod.stop();
  });

  it('supports manual quota operations (disable/recover/reset)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('tab.default.gpt-5.1', { authType: 'apikey' });
    await mod.start();

    const disabled = await mod.disableProvider({
      providerKey: 'tab.default.gpt-5.1',
      mode: 'cooldown',
      durationMs: 60_000
    });
    expect(disabled).not.toBeNull();
    expect(disabled!.state.inPool).toBe(false);
    expect(disabled!.state.reason).toBe('cooldown');
    expect(disabled!.state.cooldownUntil).toBe(Date.now() + 60_000);

    const recovered = await mod.recoverProvider('tab.default.gpt-5.1');
    expect(recovered).not.toBeNull();
    expect(recovered!.state.inPool).toBe(true);
    expect(recovered!.state.reason).toBe('ok');
    expect(recovered!.state.cooldownUntil).toBeNull();
    expect(recovered!.state.blacklistUntil).toBeNull();

    const reset = await mod.resetProvider('tab.default.gpt-5.1');
    expect(reset).not.toBeNull();
    expect(reset!.state.inPool).toBe(true);
    expect(reset!.state.reason).toBe('ok');

    await mod.stop();
  });

  it('resetProvider clears capacity backoff (modelBackoff) so quotaView no longer blocks selection', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_429',
      message: 'HTTP 429: {"error":{"message":"No capacity available for model gpt-5.1"}}',
      stage: 'provider.provider.http',
      status: 429,
      recoverable: false,
      timestamp: now,
      runtime: {
        requestId: 'req_capacity',
        providerKey: 'tab.default.gpt-5.1',
        providerId: 'tab'
      },
      details: {}
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const view1 = mod.getQuotaView();
    expect(view1).not.toBeNull();
    const entry1 = view1!('tab.default.gpt-5.1');
    expect(entry1?.reason).toBe('cooldown:model-capacity');
    expect(typeof entry1?.cooldownUntil).toBe('number');
    expect((entry1?.cooldownUntil as number) > now).toBe(true);

    const reset = await mod.resetProvider('tab.default.gpt-5.1');
    expect(reset).not.toBeNull();

    const view2 = mod.getQuotaView();
    const entry2 = view2!('tab.default.gpt-5.1');
    expect(entry2?.reason).toBe('ok');
    expect(entry2?.cooldownUntil ?? null).toBeNull();

    await mod.stop();
  });

  it('blacklists apikey providers on HTTP 402 until upstream resetAt', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-02T08:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('crs.key1.gpt-5.2', { authType: 'apikey' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_402',
      message:
        'HTTP 402: {"error":{"type":"insufficient_quota","message":"daily limit","code":"daily_cost_limit_exceeded"},"resetAt":"2026-02-02T16:00:00.000Z"}',
      stage: 'provider.provider.http',
      status: 402,
      recoverable: false,
      timestamp: now,
      runtime: {
        requestId: 'req_test_402',
        providerKey: 'crs.key1.gpt-5.2',
        providerId: 'crs'
      },
      details: {}
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot['crs.key1.gpt-5.2']).toBeDefined();
    expect(snapshot['crs.key1.gpt-5.2'].inPool).toBe(false);
    expect(snapshot['crs.key1.gpt-5.2'].reason).toBe('blacklist');
    expect(snapshot['crs.key1.gpt-5.2'].blacklistUntil).toBe(Date.parse('2026-02-02T16:00:00.000Z'));

    await mod.stop();
  });

  it('blacklists apikey providers on HTTP 402 until configured daily reset time when resetAt missing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-02T10:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('crs.key1.gpt-5.2', { authType: 'apikey', apikeyDailyResetTime: '12:00Z' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'HTTP_402',
      message: 'HTTP 402: {"error":{"type":"insufficient_quota","message":"daily limit","code":"daily_cost_limit_exceeded"}}',
      stage: 'provider.provider.http',
      status: 402,
      recoverable: false,
      timestamp: now,
      runtime: {
        requestId: 'req_test_402_nors',
        providerKey: 'crs.key1.gpt-5.2',
        providerId: 'crs'
      },
      details: {}
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot['crs.key1.gpt-5.2']).toBeDefined();
    expect(snapshot['crs.key1.gpt-5.2'].inPool).toBe(false);
    expect(snapshot['crs.key1.gpt-5.2'].reason).toBe('blacklist');
    expect(snapshot['crs.key1.gpt-5.2'].blacklistUntil).toBe(Date.parse('2026-02-02T12:00:00.000Z'));

    await mod.stop();
  });

  it('persists windsurf weekly blacklist across daemon restart', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-21T00:00:00.000Z'));
    const now = Date.now();
    const providerKey = 'windsurf.ws-pro-1.gpt-5.4-medium';

    const mod1 = new ProviderQuotaDaemonModule();
    await mod1.init({ serverId: 'test' });
    mod1.registerProviderStaticConfig(providerKey, { authType: 'apikey' });
    await mod1.start();

    await emitProviderError(mod1, {
      code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
      message: 'Your weekly usage quota has been exhausted.',
      stage: 'provider.send',
      status: 429,
      recoverable: false,
      affectsHealth: true,
      timestamp: now,
      runtime: {
        requestId: 'req_ws_weekly_restart',
        providerKey,
        providerId: 'windsurf'
      },
      details: {
        errorClassification: 'unrecoverable',
        routePoolSize: 3,
        rateLimitKind: 'daily_limit',
        quotaScope: 'weekly',
        quotaReason: 'windsurf_weekly_exhausted'
      }
    } as any);

    await jest.advanceTimersByTimeAsync(10);

    const snapshotBeforeStop = mod1.getAdminSnapshot();
    expect(snapshotBeforeStop[providerKey]).toBeDefined();
    expect(snapshotBeforeStop[providerKey].inPool).toBe(true);
    expect(snapshotBeforeStop[providerKey].reason).toBe('cooldown');
    expect(snapshotBeforeStop[providerKey].cooldownKeepsPool).toBe(true);
    const expectedLocalMidnight = new Date(2026, 4, 22, 0, 0, 0, 0).getTime();
    expect(snapshotBeforeStop[providerKey].cooldownUntil).toBe(expectedLocalMidnight);
    expect(snapshotBeforeStop[providerKey].blacklistUntil).toBeNull();

    await mod1.stop();

    const mod2 = new ProviderQuotaDaemonModule();
    await mod2.init({ serverId: 'test' });
    mod2.registerProviderStaticConfig(providerKey, { authType: 'apikey' });

    const snapshotAfterRestart = mod2.getAdminSnapshot();
    expect(snapshotAfterRestart[providerKey]).toBeDefined();
    expect(snapshotAfterRestart[providerKey].inPool).toBe(true);
    expect(snapshotAfterRestart[providerKey].reason).toBe('cooldown');
    expect(snapshotAfterRestart[providerKey].cooldownKeepsPool).toBe(true);
    expect(snapshotAfterRestart[providerKey].cooldownUntil).toBe(expectedLocalMidnight);
    expect(snapshotAfterRestart[providerKey].blacklistUntil).toBeNull();

    const quotaView = mod2.getQuotaView();
    expect(quotaView).not.toBeNull();
    expect(quotaView!(providerKey)?.inPool).toBe(true);
    expect(quotaView!(providerKey)?.reason).toBe('cooldown');
  });

  it('startup recovers registered providers from stale cooldown without deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-23T22:40:00.000Z'));
    const now = Date.now();
    const providerKey = 'windsurf.ws-pro-5.gpt-5.4-none';
    const staleState = {
      ...createInitialQuotaState(providerKey, { authType: 'apikey' }, now),
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: null,
      blacklistUntil: null,
      lastErrorSeries: 'E5XX',
      lastErrorCode: 'WINDSURF_SERVICE_UNREACHABLE',
      lastErrorAtMs: now - 60_000,
      consecutiveErrorCount: 4
    };
    await fs.writeFile(path.join(tempQuotaDir!, 'provider-quota.json'), `${JSON.stringify({
      version: 1,
      updatedAt: new Date(now).toISOString(),
      providers: { [providerKey]: staleState }
    }, null, 2)}\n`, 'utf8');

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig(providerKey, { authType: 'apikey' });
    await mod.start();

    const quotaView = mod.getQuotaView();
    expect(quotaView!(providerKey)?.inPool).toBe(true);
    expect(quotaView!(providerKey)?.reason).toBe('ok');
    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].reason).toBe('ok');
    expect(snapshot[providerKey].lastErrorCode).toBeNull();
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(0);

    await mod.stop();
  });

  it('does not persist cooldown when Windsurf local service is unreachable', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-23T22:50:00.000Z'));
    const now = Date.now();
    const providerKey = 'windsurf.ws-pro-4.gpt-5.4-none';

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig(providerKey, { authType: 'oauth' });
    await mod.start();

    await emitProviderError(mod, {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      message: '[windsurf] service unreachable',
      stage: 'provider.send',
      status: 502,
      recoverable: true,
      affectsHealth: true,
      timestamp: now,
      runtime: {
        requestId: 'req_ws_unreachable',
        providerKey,
        providerId: 'windsurf'
      },
      details: {}
    } as any);

    await jest.advanceTimersByTimeAsync(5);

    const snapshot = mod.getAdminSnapshot();
    expect(snapshot[providerKey].inPool).toBe(true);
    expect(snapshot[providerKey].reason).toBe('ok');
    expect(snapshot[providerKey].cooldownUntil).toBeNull();
    expect(snapshot[providerKey].lastErrorCode).toBeNull();
    expect(snapshot[providerKey].consecutiveErrorCount).toBe(0);

    await mod.stop();
  });
});
