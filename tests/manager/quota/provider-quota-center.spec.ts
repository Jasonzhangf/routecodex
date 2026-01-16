import {
  applyErrorEvent,
  applySuccessEvent,
  applyUsageEvent,
  createInitialQuotaState,
  tickQuotaStateTime
} from '../../../src/manager/quota/provider-quota-center.js';

describe('provider-quota-center error handling', () => {
  const providerKey = 'antigravity.alias1.gemini-3-pro-high';

  it('applies 1/3/5 minute cooldowns for repeated 429s and then 3h blacklist for apikey providers', () => {
    const baseNow = 1_000_000;
    let state = createInitialQuotaState(providerKey, { authType: 'apikey' }, baseNow);

    // first 429 -> 1 minute cooldown
    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 429 },
      baseNow
    );
    expect(state.inPool).toBe(false);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(baseNow + 60_000);
    expect(state.blacklistUntil).toBeNull();
    expect(state.consecutiveErrorCount).toBe(1);

    // second 429 -> 3 minutes cooldown
    const secondNow = baseNow + 10_000;
    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 429 },
      secondNow
    );
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(secondNow + 3 * 60_000);
    expect(state.blacklistUntil).toBeNull();
    expect(state.consecutiveErrorCount).toBe(2);

    // third 429 -> 3h blacklist
    const thirdNow = secondNow + 10_000;
    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 429 },
      thirdNow
    );
    expect(state.reason).toBe('blacklist');
    expect(state.inPool).toBe(false);
    expect(state.blacklistUntil).toBe(thirdNow + 3 * 60 * 60_000);
    expect(state.cooldownUntil).toBeNull();
    expect(state.consecutiveErrorCount).toBe(3);
  });

  it('loops 1/3/5 minute cooldown for network errors (no long blacklist)', () => {
    const baseNow = 4_000_000;
    let state = createInitialQuotaState(providerKey, { authType: 'apikey' }, baseNow);

    state = applyErrorEvent(state, { providerKey, code: 'ETIMEDOUT' }, baseNow);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(baseNow + 60_000);

    const secondNow = baseNow + 10_000;
    state = applyErrorEvent(state, { providerKey, code: 'ETIMEDOUT' }, secondNow);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(secondNow + 3 * 60_000);

    const thirdNow = secondNow + 10_000;
    state = applyErrorEvent(state, { providerKey, code: 'ETIMEDOUT' }, thirdNow);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(thirdNow + 5 * 60_000);

    const fourthNow = thirdNow + 10_000;
    state = applyErrorEvent(state, { providerKey, code: 'ETIMEDOUT' }, fourthNow);
    expect(state.reason).toBe('cooldown');
    expect(state.blacklistUntil).toBeNull();
    expect(state.cooldownUntil).toBe(fourthNow + 5 * 60_000);
  });

  it('blacklists unknown errors for 1h after repeated series', () => {
    const baseNow = 5_000_000;
    let state = createInitialQuotaState(providerKey, { authType: 'apikey' }, baseNow);

    state = applyErrorEvent(state, { providerKey, code: 'E_UNKNOWN' }, baseNow);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(baseNow + 60_000);

    const secondNow = baseNow + 10_000;
    state = applyErrorEvent(state, { providerKey, code: 'E_UNKNOWN' }, secondNow);
    expect(state.reason).toBe('cooldown');
    expect(state.cooldownUntil).toBe(secondNow + 3 * 60_000);

    const thirdNow = secondNow + 10_000;
    state = applyErrorEvent(state, { providerKey, code: 'E_UNKNOWN' }, thirdNow);
    expect(state.reason).toBe('blacklist');
    expect(state.blacklistUntil).toBe(thirdNow + 60 * 60_000);
    expect(state.cooldownUntil).toBeNull();
  });

  it('resets consecutive counter when series changes', () => {
    const baseNow = 2_000_000;
    let state = createInitialQuotaState(providerKey, undefined, baseNow);

    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 500 },
      baseNow
    );
    expect(state.consecutiveErrorCount).toBe(1);

    // different series (429 instead of 5xx) should reset counter to 1
    const nextNow = baseNow + 5_000;
    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 429 },
      nextNow
    );
    expect(state.consecutiveErrorCount).toBe(1);
  });

  it('treats fatal errors as 6h blacklist that does not auto-clear on success inside window', () => {
    const baseNow = 3_000_000;
    let state = createInitialQuotaState(providerKey, undefined, baseNow);

    state = applyErrorEvent(
      state,
      { providerKey, httpStatus: 401, fatal: true },
      baseNow
    );
    expect(state.reason).toBe('fatal');
    expect(state.inPool).toBe(false);
    expect(state.blacklistUntil).toBe(baseNow + 6 * 60 * 60_000);

    const successNow = baseNow + 60_000;
    const afterSuccess = applySuccessEvent(
      state,
      { providerKey, usedTokens: 10 },
      successNow
    );
    expect(afterSuccess.reason).toBe('fatal');
    expect(afterSuccess.inPool).toBe(false);
    expect(afterSuccess.blacklistUntil).toBe(state.blacklistUntil);
  });
});

describe('provider-quota-center usage and window handling', () => {
  const providerKey = 'tab.key1.gpt-5.1';

  it('enforces rateLimitPerMinute and recovers after window reset', () => {
    const baseNow = 10_000;
    let state = createInitialQuotaState(
      providerKey,
      { rateLimitPerMinute: 2 },
      baseNow
    );

    // first two requests within window are allowed
    state = applyUsageEvent(state, { providerKey }, baseNow + 1_000);
    expect(state.reason).toBe('ok');
    state = applyUsageEvent(state, { providerKey }, baseNow + 2_000);
    expect(state.reason).toBe('ok');

    // third request in the same minute should deplete quota
    state = applyUsageEvent(state, { providerKey }, baseNow + 3_000);
    expect(state.reason).toBe('quotaDepleted');
    expect(state.inPool).toBe(false);

    // move time forward beyond window; tick should reset window and restore pool
    const nextWindowNow = baseNow + 70_000;
    state = tickQuotaStateTime(state, nextWindowNow);
    expect(state.reason).toBe('ok');
    expect(state.inPool).toBe(true);
    expect(state.requestsThisWindow).toBe(0);
  });

  it('tracks token limits and enforces totalTokenLimit', () => {
    const baseNow = 20_000;
    let state = createInitialQuotaState(
      providerKey,
      { tokenLimitPerMinute: 100, totalTokenLimit: 150 },
      baseNow
    );

    // first usage within limits
    state = applyUsageEvent(
      state,
      { providerKey, requestedTokens: 60 },
      baseNow + 1_000
    );
    expect(state.reason).toBe('ok');
    expect(state.tokensThisWindow).toBe(60);
    expect(state.totalTokensUsed).toBe(60);

    // second usage exceeds per-minute token limit
    state = applyUsageEvent(
      state,
      { providerKey, requestedTokens: 50 },
      baseNow + 2_000
    );
    expect(state.reason).toBe('quotaDepleted');
    expect(state.inPool).toBe(false);

    // even在新窗口，总 token 已接近上限，继续使用会触发 totalTokenLimit
    const nextWindowNow = baseNow + 70_000;
    state = tickQuotaStateTime(state, nextWindowNow);
    expect(state.inPool).toBe(true);

    state = applyUsageEvent(
      state,
      { providerKey, requestedTokens: 100 },
      nextWindowNow + 1_000
    );
    expect(state.reason).toBe('quotaDepleted');
    expect(state.totalTokensUsed).toBeGreaterThan(150);
  });

  it('does not recover quotaDepleted while cooldown is active (even after window reset)', () => {
    const baseNow = 30_000;
    let state = createInitialQuotaState(providerKey, { rateLimitPerMinute: 1 }, baseNow);

    state = applyUsageEvent(state, { providerKey }, baseNow + 1_000);
    expect(state.reason).toBe('ok');

    state = applyUsageEvent(state, { providerKey }, baseNow + 2_000);
    expect(state.reason).toBe('quotaDepleted');
    expect(state.inPool).toBe(false);

    // Simulate an upstream deterministic cooldown window (e.g. quota exhausted until reset).
    state = {
      ...state,
      cooldownUntil: baseNow + 5 * 60_000
    };

    // Advance beyond window but still within cooldown.
    const nextWindowNow = baseNow + 70_000;
    state = tickQuotaStateTime(state, nextWindowNow);
    expect(state.inPool).toBe(false);
    expect(state.reason).toBe('quotaDepleted');
    expect(state.cooldownUntil).toBe(baseNow + 5 * 60_000);
  });

  it('repairs inconsistent snapshots where inPool=true but cooldown is still active', () => {
    const baseNow = 40_000;
    const cooldownUntil = baseNow + 10 * 60_000;
    const state: any = {
      ...createInitialQuotaState(providerKey, {}, baseNow),
      inPool: true,
      reason: 'ok',
      cooldownUntil
    };
    const ticked = tickQuotaStateTime(state, baseNow + 60_000);
    expect(ticked.inPool).toBe(false);
    expect(ticked.reason).toBe('cooldown');
    expect(ticked.cooldownUntil).toBe(cooldownUntil);
  });
});
