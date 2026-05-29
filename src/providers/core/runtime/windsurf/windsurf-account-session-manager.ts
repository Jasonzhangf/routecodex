import {
  WindsurfAccountPool,
  type PoolConfigEntry,
} from './windsurf-account-pool.js';

export type WindsurfRefreshResult = {
  apiKey: string;
  auth1Token?: string;
  accountId?: string;
  primaryOrgId?: string;
};

export type WindsurfRefreshCallback = (alias: string, entry: PoolConfigEntry) => Promise<WindsurfRefreshResult>;

export class WindsurfAccountSessionManager {
  private readonly pool: WindsurfAccountPool;
  private readonly refreshCallback: WindsurfRefreshCallback;
  private readonly refreshPromises = new Map<string, Promise<WindsurfRefreshResult>>();

  constructor(pool: WindsurfAccountPool, refreshCallback: WindsurfRefreshCallback) {
    this.pool = pool;
    this.refreshCallback = refreshCallback;
  }

  /**
   * Refresh credentials for a specific account, with dedup.
   * If a refresh is already in progress for this alias, returns the existing promise.
   */
  async refreshAccount(alias: string, entry: PoolConfigEntry): Promise<WindsurfRefreshResult> {
    const existing = this.refreshPromises.get(alias);
    if (existing) return existing;

    const promise = this.doRefresh(alias, entry);
    this.refreshPromises.set(alias, promise);
    try {
      return await promise;
    } finally {
      this.refreshPromises.delete(alias);
    }
  }

  private async doRefresh(alias: string, entry: PoolConfigEntry): Promise<WindsurfRefreshResult> {
    try {
      const result = await this.refreshCallback(alias, entry);
      // On success, mark account auth as ready
      this.pool.markSuccess(alias);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuthError = /401|invalid.*(email|password|token)|devin.*session.*token/i.test(message);
      const isQuotaError = /quota.*exhausted|plan.*exhausted|daily.*limit|weekly.*limit/i.test(message);

      if (isAuthError) {
        this.pool.markAuthInvalid(alias, message);
      } else if (isQuotaError) {
        this.pool.markQuotaExhausted(alias, message);
      } else {
        this.pool.markAuthBackoff(alias, message);
      }
      throw error;
    }
  }

  isRefreshing(alias: string): boolean {
    return this.refreshPromises.has(alias);
  }
}
