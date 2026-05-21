/**
 * WindsurfProvider Contract
 *
 * WindsurfAPI Provider V2 专有配置与常量定义。
 */

import type { UnknownObject } from '../../../types/common-types.js';

export const WINDSURF_COMPATIBILITY_PROFILE = 'chat:windsurf';

export enum WindsurfErrorCode {
  AUTH_FAILED = 'WINDSURF_AUTH_FAILED',
  ACCOUNT_QUOTA_EXHAUSTED = 'WINDSURF_ACCOUNT_QUOTA_EXHAUSTED',
  ALL_ACCOUNTS_UNAVAILABLE = 'WINDSURF_ALL_ACCOUNTS_UNAVAILABLE',
  CASCADE_SESSION_NOT_FOUND = 'WINDSURF_CASCADE_SESSION_NOT_FOUND',
  LANGUAGE_SERVER_UNAVAILABLE = 'WINDSURF_LANGUAGE_SERVER_UNAVAILABLE',
  MODEL_UNSUPPORTED = 'WINDSURF_MODEL_UNSUPPORTED',
  TOOL_REQUIRED_BUT_MISSING = 'WINDSURF_TOOL_REQUIRED_BUT_MISSING',
  SERVICE_UNREACHABLE = 'WINDSURF_SERVICE_UNREACHABLE',
  RESPONSE_PARSE_FAILED = 'WINDSURF_RESPONSE_PARSE_FAILED',
  REQUEST_BUILD_FAILED = 'WINDSURF_REQUEST_BUILD_FAILED',
}

export type WindsurfAccountTier = 'pro' | 'trial' | 'free';

export interface WindsurfAccountEntry {
  alias: string;
  token: string | null;
  tier?: WindsurfAccountTier;
  tierManual?: boolean;
  tokenFile?: string;
}

export type WindsurfTransportBackend = 'cascade-cloud';

export interface WindsurfProviderRuntimeOptions {
  enableThinking?: boolean;
  defaultReasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low';
  sanitizePaths?: boolean;
  preserveUpstreamIdentity?: boolean;
  toolEmulationStrict?: boolean;
  healthCheckEndpoint?: string;
  healthCheckTimeoutMs?: number;
  /** Transport mode. Only cloud cascade mainline is allowed. */
  transportBackend?: WindsurfTransportBackend;
  /** Primary cloud endpoint. */
  apiBaseUrl?: string;
  /** Secondary cloud endpoint. */
  apiBaseUrlFallback?: string;
  /** Poll interval for cloud progress fetch (ms) */
  pollIntervalMs?: number;
  /** Poll max wait (ms) */
  pollMaxWaitMs?: number;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeWindsurfProviderRuntimeOptions(
  source: UnknownObject | undefined
): WindsurfProviderRuntimeOptions {
  if (!source || typeof source !== 'object') return {};
  const raw = source as Record<string, unknown>;
  return {
    enableThinking: typeof raw.enableThinking === 'boolean' ? raw.enableThinking : undefined,
    defaultReasoningEffort:
      typeof raw.defaultReasoningEffort === 'string' && ['xhigh','high','medium','low'].includes(raw.defaultReasoningEffort)
        ? raw.defaultReasoningEffort as WindsurfProviderRuntimeOptions['defaultReasoningEffort']
        : undefined,
    sanitizePaths: typeof raw.sanitizePaths === 'boolean' ? raw.sanitizePaths : undefined,
    preserveUpstreamIdentity: typeof raw.preserveUpstreamIdentity === 'boolean' ? raw.preserveUpstreamIdentity : undefined,
    toolEmulationStrict: typeof raw.toolEmulationStrict === 'boolean' ? raw.toolEmulationStrict : undefined,
    healthCheckEndpoint: readNonEmptyString(raw.healthCheckEndpoint),
    healthCheckTimeoutMs: typeof raw.healthCheckTimeoutMs === 'number' && raw.healthCheckTimeoutMs > 0 ? raw.healthCheckTimeoutMs : undefined,
    transportBackend: raw.transportBackend === 'cascade-cloud' ? raw.transportBackend : undefined,
    apiBaseUrl: readNonEmptyString(raw.apiBaseUrl),
    apiBaseUrlFallback: readNonEmptyString(raw.apiBaseUrlFallback),
    pollIntervalMs: typeof raw.pollIntervalMs === 'number' && raw.pollIntervalMs > 0 ? Math.floor(raw.pollIntervalMs) : undefined,
    pollMaxWaitMs: typeof raw.pollMaxWaitMs === 'number' && raw.pollMaxWaitMs > 0 ? Math.floor(raw.pollMaxWaitMs) : undefined,
  };
}

/** 运行时身份判定：给定字段组合是否命中 Windsurf 家族 */
export function isWindsurfRuntimeIdentity(opts: {
  providerFamily?: string;
  providerId?: string;
  providerKey?: string;
  compatibilityProfile?: string;
}): boolean {
  const read = (v?: string): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const pf = read(opts.providerFamily);
  const pid = read(opts.providerId);
  const pkey = read(opts.providerKey);
  const cp = read(opts.compatibilityProfile);
  return (
    cp === 'chat:windsurf' ||
    cp === WINDSURF_COMPATIBILITY_PROFILE ||
    pid === 'windsurf' ||
    pid.startsWith('windsurf.') ||
    pkey === 'windsurf' ||
    pkey.startsWith('windsurf.') ||
    pf === 'windsurf'
  );
}
