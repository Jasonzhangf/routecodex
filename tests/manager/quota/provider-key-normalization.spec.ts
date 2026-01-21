import { canonicalizeProviderKey, mergeQuotaStates } from '../../../src/manager/modules/quota/provider-key-normalization.js';
import { createInitialQuotaState } from '../../../src/manager/quota/provider-quota-center.js';

describe('provider key normalization', () => {
  test('canonicalizeProviderKey: leaves non-antigravity keys unchanged', () => {
    expect(canonicalizeProviderKey('tab.default.gpt-5.2')).toBe('tab.default.gpt-5.2');
    expect(canonicalizeProviderKey('')).toBe('');
    expect(canonicalizeProviderKey('   ')).toBe('');
  });

  test('canonicalizeProviderKey: strips sequence prefix for antigravity alias', () => {
    expect(canonicalizeProviderKey('antigravity.1-foo.bar')).toBe('antigravity.foo.bar');
    expect(canonicalizeProviderKey('antigravity.23-geetasamodgeetasamoda.claude-sonnet-4-5-thinking'))
      .toBe('antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking');
  });

  test('mergeQuotaStates: returns default state when empty', () => {
    const key = 'tab.default.gpt-5.2';
    const merged = mergeQuotaStates(key, []);
    expect(merged.providerKey).toBe(key);
  });

  test('mergeQuotaStates: upgrades worst reason and merges counters', () => {
    const now = Date.now();
    const providerKey = 'antigravity.foo.claude-sonnet-4-5-thinking';
    const baseOk = {
      ...createInitialQuotaState(providerKey, { authType: 'unknown' }, now),
      windowStartMs: now + 10
    } as any;
    const worseCooldown = {
      ...baseOk,
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: now + 60_000,
      authType: 'apikey',
      consecutiveErrorCount: 2,
      lastErrorSeries: 'E429',
      windowStartMs: now
    } as any;
    const worseBlacklist = {
      ...baseOk,
      inPool: false,
      reason: 'blacklist',
      blacklistUntil: now + 120_000,
      consecutiveErrorCount: 5,
      lastErrorSeries: 'E5XX',
      windowStartMs: now + 1
    } as any;

    const merged = mergeQuotaStates(providerKey, [baseOk, worseCooldown, worseBlacklist]);
    expect(merged.inPool).toBe(false);
    expect(merged.reason).toBe('blacklist');
    expect(merged.authType).toBe('apikey');
    expect(merged.consecutiveErrorCount).toBe(5);
    expect(merged.lastErrorSeries).toBe('E5XX');
  });

  test('mergeQuotaStates: picks worst gating and max ttl', () => {
    const now = Date.now();
    const providerKey = 'antigravity.foo.claude-sonnet-4-5-thinking';
    const ok = createInitialQuotaState(providerKey, { authType: 'oauth' }, now);
    const cooldown = {
      ...ok,
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: now + 60_000,
      windowStartMs: now + 1
    } as any;
    const blacklist = {
      ...ok,
      inPool: false,
      reason: 'blacklist',
      blacklistUntil: now + 120_000,
      windowStartMs: now + 2
    } as any;

    const merged = mergeQuotaStates(providerKey, [ok, cooldown, blacklist]);
    expect(merged.providerKey).toBe(providerKey);
    expect(merged.inPool).toBe(false);
    expect(merged.reason).toBe('blacklist');
    expect(merged.cooldownUntil).toBe(now + 60_000);
    expect(merged.blacklistUntil).toBe(now + 120_000);
  });

  test('mergeQuotaStates: forces ok+activeCooldown into cooldown', () => {
    const now = Date.now();
    const providerKey = 'tab.default.gpt-5.2';
    const inconsistent = {
      ...createInitialQuotaState(providerKey, { authType: 'apikey' }, now),
      reason: 'ok',
      inPool: true,
      cooldownUntil: now + 60_000
    } as any;
    const merged = mergeQuotaStates(providerKey, [inconsistent]);
    expect(merged.inPool).toBe(false);
    expect(merged.reason).toBe('cooldown');
  });
});
