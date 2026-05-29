import {
  WindsurfAccountStore,
  type WindsurfPersistedAccount,
} from './windsurf-account-store.js';

export const WINDSURF_QUOTA_COOLDOWN_MS = 24 * 3600_000;
export const WINDSURF_AUTH_BACKOFF_MS = 10 * 60_000;
export const WINDSURF_RUNTIME_BACKOFF_MS = 2 * 60_000;
export const WINDSURF_STICKY_TTL_MS = 30 * 60_000;
export const WINDSURF_STICKY_MAX_BINDINGS = 10_000;

export type PoolConfigEntry = {
  alias?: string;
  apiKey?: string;
  env?: string;
  tokenFile?: string;
  accountAlias?: string;
  account?: string;
  username?: string;
  mobile?: string;
  password?: string;
  extra?: boolean;
};

export type PoolSelectionResult = {
  accountAlias: string;
  apiKey: string;
  entry: PoolConfigEntry;
  sticky: boolean;
};

export type PoolErrorCode =
  | 'WINDSURF_ACCOUNT_POOL_COOLDOWN'
  | 'WINDSURF_NO_HEALTHY_ACCOUNT'
  | 'WINDSURF_NO_CONFIGURED_ACCOUNT';

export class PoolAllExhaustedError extends Error {
  code: PoolErrorCode;
  retryable: boolean;
  cooldownOverrideMs?: number;
  rateLimitKind?: string;

  constructor(code: PoolErrorCode, message: string, cooldownMs?: number) {
    super(message);
    this.name = 'PoolAllExhaustedError';
    this.code = code;
    this.retryable = true;
    this.rateLimitKind = code === 'WINDSURF_ACCOUNT_POOL_COOLDOWN' ? 'synthetic_cooldown' : 'short_lived';
    if (cooldownMs && cooldownMs > 0) {
      this.cooldownOverrideMs = cooldownMs;
    }
  }
}

type StickyBinding = {
  accountAlias: string;
  createdAt: number;
  lastAccess: number;
};

function bindingKey(sessionKey: string, modelKey: string): string {
  return sessionKey + '\0' + (modelKey || '*');
}

export class WindsurfAccountPool {
  private readonly store: WindsurfAccountStore;
  private readonly stickyBindings = new Map<string, StickyBinding>();

  constructor(store: WindsurfAccountStore) {
    this.store = store;
  }

  async selectAccount(
    entries: PoolConfigEntry[],
    sessionKey: string,
    requestedModelUid?: string,
  ): Promise<PoolSelectionResult> {
    if (!entries || entries.length === 0) {
      throw new PoolAllExhaustedError('WINDSURF_NO_CONFIGURED_ACCOUNT', 'windsurf managed account pool has no configured account');
    }

    const now = Date.now();
    const modelKey = (requestedModelUid || '').trim().toLowerCase();

    // Ensure store records exist for all entries
    for (const entry of entries) {
      const alias = entry.alias || entry.accountAlias || 'default';
      const email = entry.account || entry.username || entry.mobile || alias;
      await this.store.ensureAccount(alias, email || alias);
    }

    // Build candidate list with store state
    const candidates: Array<{ entry: PoolConfigEntry; account: WindsurfPersistedAccount; sticky: boolean }> = [];

    for (const entry of entries) {
      const alias = entry.alias || entry.accountAlias || 'default';
      const account = this.store.getAccount(alias);
      if (!account) continue;

      // Skip quota cooldown
      if (account.quota.status === 'cooldown' && account.quota.cooldownUntil && now < account.quota.cooldownUntil) {
        continue;
      }

      // Skip auth backoff
      if (account.auth.status === 'backoff' && account.auth.backoffUntil && now < account.auth.backoffUntil) {
        continue;
      }

      // Skip auth invalid (needs refresh)
      if (account.auth.status === 'invalid') {
        continue;
      }

      // Skip runtime backoff
      if (account.runtime.status === 'backoff' && account.runtime.backoffUntil && now < account.runtime.backoffUntil) {
        continue;
      }

      candidates.push({ entry, account, sticky: false });
    }

    if (candidates.length === 0) {
      // Compute min cooldown time for error
      const cooldowns: number[] = [];
      for (const entry of entries) {
        const alias = entry.alias || entry.accountAlias || 'default';
        const account = this.store.getAccount(alias);
        if (!account) continue;
        const quotaUntil = account.quota.cooldownUntil || 0;
        const authUntil = account.auth.backoffUntil || 0;
        const runtimeUntil = account.runtime.backoffUntil || 0;
        const nextAvailable = Math.max(quotaUntil, authUntil, runtimeUntil);
        if (nextAvailable > now) {
          cooldowns.push(nextAvailable - now);
        }
      }
      const minCooldown = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;

      if (minCooldown > 0) {
        throw new PoolAllExhaustedError(
          'WINDSURF_ACCOUNT_POOL_COOLDOWN',
          `windsurf managed account pool is cooling down (next available in ${Math.ceil(minCooldown / 1000)}s)`,
          minCooldown,
        );
      }
      throw new PoolAllExhaustedError(
        'WINDSURF_NO_HEALTHY_ACCOUNT',
        'windsurf managed account pool has no healthy account',
      );
    }

    // Check sticky binding first
    const stickyKey = bindingKey(sessionKey, modelKey);
    const stickyBinding = this.stickyBindings.get(stickyKey);
    if (stickyBinding && now - stickyBinding.lastAccess <= WINDSURF_STICKY_TTL_MS) {
      const stickyCandidate = candidates.find((c) => {
        const alias = c.entry.alias || c.entry.accountAlias || 'default';
        return alias === stickyBinding!.accountAlias;
      });
      if (stickyCandidate) {
        stickyCandidate.sticky = true;
        stickyBinding.lastAccess = now;
        return this.buildResult(stickyCandidate, sessionKey, modelKey);
      }
      // Sticky binding exists but account is unavailable — clear it
      this.stickyBindings.delete(stickyKey);
    }

    // Rank candidates: sort by health score
    const ranked = this.rankCandidates(candidates);

    // Select best candidate
    const selected = ranked[0];
    return this.buildResult(selected, sessionKey, modelKey);
  }

  private rankCandidates(
    candidates: Array<{ entry: PoolConfigEntry; account: WindsurfPersistedAccount; sticky: boolean }>,
  ): Array<{ entry: PoolConfigEntry; account: WindsurfPersistedAccount; sticky: boolean }> {
    return [...candidates].sort((a, b) => {
      // Prefer lower consecutive failures
      if (a.account.routing.consecutiveFailures !== b.account.routing.consecutiveFailures) {
        return a.account.routing.consecutiveFailures - b.account.routing.consecutiveFailures;
      }
      // Prefer more recent success
      const aLast = a.account.routing.lastSuccessAt ?? 0;
      const bLast = b.account.routing.lastSuccessAt ?? 0;
      if (aLast !== bLast) {
        return bLast - aLast;
      }
      // Prefer extra accounts
      if (a.entry.extra !== b.entry.extra) {
        return a.entry.extra ? -1 : 1;
      }
      return 0;
    });
  }

  private buildResult(
    candidate: { entry: PoolConfigEntry; account: WindsurfPersistedAccount; sticky: boolean },
    sessionKey: string,
    modelKey: string,
  ): PoolSelectionResult {
    const alias = candidate.entry.alias || candidate.entry.accountAlias || 'default';
    const apiKey = candidate.entry.apiKey || '';

    // Update sticky binding
    if (sessionKey) {
      const key = bindingKey(sessionKey, modelKey);
      this.stickyBindings.set(key, {
        accountAlias: alias,
        createdAt: Date.now(),
        lastAccess: Date.now(),
      });
    }

    // Update store routing state
    this.store.updateAccount(alias, (acc) => ({
      ...acc,
      routing: {
        ...acc.routing,
        lastSelectedAt: Date.now(),
      },
    }));

    return { accountAlias: alias, apiKey, entry: candidate.entry, sticky: candidate.sticky };
  }

  markSuccess(accountAlias: string): void {
    this.store.updateAccount(accountAlias, (acc) => ({
      ...acc,
      routing: {
        stickyScore: acc.routing.stickyScore + 1,
        lastSelectedAt: acc.routing.lastSelectedAt,
        lastSuccessAt: Date.now(),
        consecutiveFailures: 0,
      },
      runtime: { ...acc.runtime, status: 'ready' as const, backoffUntil: null },
    }));
  }

  markQuotaExhausted(accountAlias: string, reason?: string): void {
    const until = Date.now() + WINDSURF_QUOTA_COOLDOWN_MS;
    this.store.updateAccount(accountAlias, (acc) => ({
      ...acc,
      quota: {
        status: 'cooldown' as const,
        cooldownUntil: until,
        lastQuotaFailureAt: Date.now(),
        lastQuotaFailureReason: reason || null,
      },
      routing: {
        ...acc.routing,
        consecutiveFailures: acc.routing.consecutiveFailures + 1,
      },
    }));
    // Break sticky binding for this account
    this.clearBindingsForAccount(accountAlias);
    this.store.save();
  }

  markAuthInvalid(accountAlias: string, reason?: string): void {
    this.store.updateAccount(accountAlias, (acc) => ({
      ...acc,
      auth: {
        status: 'invalid' as const,
        lastAuthFailureAt: Date.now(),
        lastAuthFailureReason: reason || null,
        lastLoginAt: acc.auth.lastLoginAt,
        backoffUntil: null,
      },
      devinSessionToken: null,
    }));
    // Break sticky binding for this account
    this.clearBindingsForAccount(accountAlias);
    this.store.save();
  }

  markAuthBackoff(accountAlias: string, reason?: string): void {
    const until = Date.now() + WINDSURF_AUTH_BACKOFF_MS;
    this.store.updateAccount(accountAlias, (acc) => ({
      ...acc,
      auth: {
        status: 'backoff' as const,
        backoffUntil: until,
        lastAuthFailureAt: Date.now(),
        lastAuthFailureReason: reason || null,
        lastLoginAt: acc.auth.lastLoginAt,
      },
    }));
    this.store.save();
  }

  markRuntimeFailure(accountAlias: string, reason?: string): void {
    const until = Date.now() + WINDSURF_RUNTIME_BACKOFF_MS;
    this.store.updateAccount(accountAlias, (acc) => ({
      ...acc,
      runtime: {
        status: 'backoff' as const,
        backoffUntil: until,
        lastRuntimeFailureAt: Date.now(),
        lastRuntimeFailureReason: reason || null,
      },
      routing: {
        ...acc.routing,
        consecutiveFailures: acc.routing.consecutiveFailures + 1,
      },
    }));
    this.store.save();
  }

  clearBindingsForAccount(accountAlias: string): void {
    for (const [key, binding] of this.stickyBindings) {
      if (binding.accountAlias === accountAlias) {
        this.stickyBindings.delete(key);
      }
    }
  }

  clearBindingsForSession(sessionKey: string): void {
    const prefix = sessionKey + '\0';
    for (const key of this.stickyBindings.keys()) {
      if (key.startsWith(prefix)) this.stickyBindings.delete(key);
    }
  }

  getStickyBinding(sessionKey: string, modelKey?: string): string | null {
    const key = bindingKey(sessionKey, modelKey || '');
    const binding = this.stickyBindings.get(key);
    if (!binding) return null;
    if (Date.now() - binding.lastAccess > WINDSURF_STICKY_TTL_MS) {
      this.stickyBindings.delete(key);
      return null;
    }
    binding.lastAccess = Date.now();
    return binding.accountAlias;
  }

  /** Check if the pool has any selectable accounts (not cooling down or fully exhausted). */
  async isPoolAvailable(entries: PoolConfigEntry[]): Promise<boolean> {
    try {
      await this.selectAccount(entries, '');
      return true;
    } catch {
      return false;
    }
  }
}
