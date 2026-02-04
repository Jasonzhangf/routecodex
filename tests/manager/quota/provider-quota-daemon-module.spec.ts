import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProviderQuotaDaemonModule } from '../../../src/manager/modules/quota/index.js';
import { createInitialQuotaState } from '../../../src/manager/quota/provider-quota-center.js';
import { getProviderErrorCenter } from '../../../src/modules/llmswitch/bridge.js';

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

describe('ProviderQuotaDaemonModule', () => {
  let tempQuotaDir: string | null = null;
  let restoreQuotaDir: (() => void) | null = null;
  let restorePersistDebounce: (() => void) | null = null;
  let restoreInterval: (() => void) | null = null;

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

    const center = await getProviderErrorCenter();
    center.emit({
      code: 'HTTP_429',
      message: 'HTTP 429: {"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 1s."}}',
      stage: 'provider.provider.http',
      status: 429,
      recoverable: false,
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
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].inPool).toBe(false);
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].reason).toBe('quotaDepleted');
    expect(snapshot1['antigravity.alias1.gemini-3-pro-high'].cooldownUntil).toBe(now + 1000);

    await jest.advanceTimersByTimeAsync(1_100);
    const quotaView = mod.getQuotaView();
    expect(quotaView).not.toBeNull();
    const entry = quotaView!('antigravity.alias1.gemini-3-pro-high');
    expect(entry?.inPool).toBe(true);

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

  it('does not let QUOTA_RECOVERY override capacity cooldown windows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    await mod.start();

    const center = await getProviderErrorCenter();
    center.emit({
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
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].inPool).toBe(false);
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].reason).toBe('cooldown');
    expect(snapshot1['antigravity.alias1.claude-sonnet-4-5-thinking'].cooldownUntil).toBe(now + 15_000);

    center.emit({
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
    expect(snapshot2['antigravity.alias1.claude-sonnet-4-5-thinking'].inPool).toBe(false);
    expect(snapshot2['antigravity.alias1.claude-sonnet-4-5-thinking'].reason).toBe('cooldown');

    await jest.advanceTimersByTimeAsync(15_100);
    const view = mod.getQuotaView();
    const entry = view?.('antigravity.alias1.claude-sonnet-4-5-thinking');
    expect(entry?.inPool).toBe(true);

    await mod.stop();
  });

  it('keeps antigravity oauth providers out of pool until quota recovery signal arrives', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));
    const now = Date.now();

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('antigravity.alias1.claude-sonnet-4-5-thinking', { authType: 'oauth' });
    await mod.start();

    const view1 = mod.getQuotaView();
    expect(view1).not.toBeNull();
    expect(view1!('antigravity.alias1.claude-sonnet-4-5-thinking')?.inPool).toBe(false);

    const center = await getProviderErrorCenter();
    center.emit({
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

    const center = await getProviderErrorCenter();
    const baseNow = Date.now();
    for (let i = 0; i < 3; i++) {
      center.emit({
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
    expect(state.inPool).toBe(false);
    expect(state.reason).toBe('cooldown');
    expect(state.blacklistUntil).toBeNull();
    expect(state.cooldownUntil).toBe(baseNow + 2_000 + 60_000);

    await jest.advanceTimersByTimeAsync(60_000 + 2_000 + 5);
    const view = mod.getQuotaView();
    const entry = view?.('tab.default.gpt-5.1');
    expect(entry?.inPool).toBe(true);

    await mod.stop();
  });

  it('caps repeated 429 backoff at 3h and then retries cyclically', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-16T00:00:00.000Z'));

    const mod = new ProviderQuotaDaemonModule();
    await mod.init({ serverId: 'test' });
    mod.registerProviderStaticConfig('tab.default.gpt-5.1', { authType: 'apikey' });
    await mod.start();

    const center = await getProviderErrorCenter();
    const baseNow = Date.now();
    const eventCount = 7; // reaches the last step in the schedule
    for (let i = 0; i < eventCount; i++) {
      center.emit({
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
    expect(state.inPool).toBe(false);
    expect(state.reason).toBe('cooldown');
    expect(state.blacklistUntil).toBeNull();
    expect(state.cooldownUntil).toBe(baseNow + (eventCount - 1) * 1000 + 10_000_000);

    // After cooldown expiry, it should re-enter the pool and reset its streak.
    await jest.advanceTimersByTimeAsync(10_000_000 + (eventCount - 1) * 1000 + 5);
    const view = mod.getQuotaView();
    const entry = view?.('tab.default.gpt-5.1');
    expect(entry?.inPool).toBe(true);

    // Next 429 should start the schedule from the first step again (5s).
    const afterCooldownNow = Date.now();
    center.emit({
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
    expect(snap2['tab.default.gpt-5.1'].cooldownUntil).toBe(afterCooldownNow + 5_000);

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

    const center = await getProviderErrorCenter();
    center.emit({
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

    const center = await getProviderErrorCenter();
    center.emit({
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

    const center = await getProviderErrorCenter();
    center.emit({
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
});
