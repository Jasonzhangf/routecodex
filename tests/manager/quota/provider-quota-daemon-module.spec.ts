import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProviderQuotaDaemonModule } from '../../../src/manager/modules/quota/index.js';
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

  it('tracks 429 backoff for apikey providers and blacklists after 3 consecutive', async () => {
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
    expect(state.reason).toBe('blacklist');
    expect(state.blacklistUntil).toBe(baseNow + 2_000 + 3 * 60 * 60_000);

    await jest.advanceTimersByTimeAsync(3 * 60 * 60_000 + 2_000 + 5);
    const view = mod.getQuotaView();
    const entry = view?.('tab.default.gpt-5.1');
    expect(entry?.inPool).toBe(true);

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
});
