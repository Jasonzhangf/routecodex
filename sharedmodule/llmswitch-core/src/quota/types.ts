export type QuotaReason =
  | 'ok'
  | 'cooldown'
  | 'blacklist'
  | 'quotaDepleted'
  | 'fatal'
  | 'authVerify';

export type QuotaAuthType = 'apikey' | 'oauth' | 'unknown';

export type QuotaAuthIssue =
  | {
      kind: 'google_account_verification';
      url?: string | null;
      message?: string | null;
    }
  | null;

export interface StaticQuotaConfig {
  priorityTier?: number | null;
  authType?: QuotaAuthType | null;
  /**
   * Daily reset time for apikey quota exhaustion (HTTP 402).
   * Format:
   * - "HH:mm" => local time
   * - "HH:mmZ" => UTC time
   * If not set, defaults to 12:00 local.
   */
  apikeyDailyResetTime?: string | null;
}

export type ErrorSeries = 'E429' | 'E5XX' | 'ENET' | 'EFATAL' | 'EOTHER';

export interface QuotaState {
  providerKey: string;
  inPool: boolean;
  reason: QuotaReason;
  authType: QuotaAuthType;
  authIssue?: QuotaAuthIssue;
  priorityTier: number;

  cooldownUntil: number | null;
  cooldownKeepsPool?: boolean;
  blacklistUntil: number | null;

  lastErrorSeries: ErrorSeries | null;
  lastErrorCode: string | null;
  lastErrorAtMs: number | null;
  consecutiveErrorCount: number;
}

export interface ErrorEventForQuota {
  providerKey: string;
  code?: string | null;
  httpStatus?: number | null;
  fatal?: boolean | null;
  timestampMs?: number;
  /**
   * Optional upstream resetAt ISO string for HTTP 402 quota depletion.
   */
  resetAt?: string | null;
  /**
   * Optional auth issue hint extracted by host/core adapters.
   */
  authIssue?: QuotaAuthIssue;
}

export interface SuccessEventForQuota {
  providerKey: string;
  timestampMs?: number;
}

export type QuotaStoreSnapshot = {
  savedAtMs: number;
  providers: Record<string, QuotaState>;
};

export interface QuotaStore {
  load(): Promise<QuotaStoreSnapshot | null>;
  save(snapshot: QuotaStoreSnapshot): Promise<void>;
}
