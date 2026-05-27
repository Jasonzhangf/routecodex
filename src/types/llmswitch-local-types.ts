export interface ProviderErrorRuntimeMetadata {
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerProtocol?: string;
  routeName?: string;
  pipelineId?: string;
  target?: Record<string, unknown> | null;
  runtimeKey?: string;
  sessionDir?: string;
  rccUserDir?: string;
}

export interface ProviderErrorEvent {
  code: string;
  message: string;
  stage: string;
  status?: number;
  recoverable?: boolean;
  affectsHealth?: boolean;
  fatal?: boolean;
  cooldownOverrideMs?: number;
  quotaScope?: string;
  quotaReason?: string;
  resetAt?: string;
  errorClassification?: 'recoverable' | 'unrecoverable' | 'special_400' | string;
  runtime: ProviderErrorRuntimeMetadata;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface ProviderSuccessRuntimeMetadata {
  requestId: string;
  routeName?: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerProtocol?: string;
  pipelineId?: string;
  target?: Record<string, unknown> | null;
  runtimeKey?: string;
  sessionDir?: string;
  rccUserDir?: string;
}

export interface ProviderSuccessEvent {
  runtime: ProviderSuccessRuntimeMetadata;
  timestamp: number;
  metadata?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface ProviderUsageEvent {
  requestId: string;
  timestamp: number;
  providerKey: string;
  runtimeKey?: string;
  providerType: string;
  modelId?: string;
  routeName?: string;
  entryEndpoint?: string;
  success: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

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
  apikeyDailyResetTime?: string | null;
}

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
  lastErrorSeries: 'E429' | 'E5XX' | 'ENET' | 'EFATAL' | 'EOTHER' | null;
  lastErrorCode: string | null;
  lastErrorAtMs: number | null;
  consecutiveErrorCount: number;
}

export type QuotaStoreSnapshot = {
  savedAtMs: number;
  providers: Record<string, QuotaState>;
};

export interface QuotaStore {
  load(): Promise<QuotaStoreSnapshot | null>;
  save(snapshot: QuotaStoreSnapshot): Promise<void>;
}
