/**
 * WindsurfProvider Contract
 *
 * 仅保留当前 provider 的最小运行时配置；唯一真相是 chat -> provider -> cascade。
 */

import type { UnknownObject } from '../../../types/common-types.js';

export const WINDSURF_COMPATIBILITY_PROFILE = 'chat:windsurf';

export enum WindsurfErrorCode {
  AUTH_FAILED = 'WINDSURF_AUTH_FAILED',
  ACCOUNT_QUOTA_EXHAUSTED = 'WINDSURF_ACCOUNT_QUOTA_EXHAUSTED',
  ALL_ACCOUNTS_UNAVAILABLE = 'WINDSURF_ALL_ACCOUNTS_UNAVAILABLE',
  CASCADE_SESSION_NOT_FOUND = 'WINDSURF_CASCADE_SESSION_NOT_FOUND',
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

export interface WindsurfProviderRuntimeOptions {
  enableThinking?: boolean;
  defaultReasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low';
  sanitizePaths?: boolean;
  preserveUpstreamIdentity?: boolean;
  toolEmulationStrict?: boolean;
  pollIntervalMs?: number;
  pollMaxWaitMs?: number;
  lsPort?: number;
  csrfToken?: string;
  sessionId?: string;
  workspacePath?: string;
  workspaceUri?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
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
      typeof raw.defaultReasoningEffort === 'string' && ['xhigh', 'high', 'medium', 'low'].includes(raw.defaultReasoningEffort)
        ? raw.defaultReasoningEffort as WindsurfProviderRuntimeOptions['defaultReasoningEffort']
        : undefined,
    sanitizePaths: typeof raw.sanitizePaths === 'boolean' ? raw.sanitizePaths : undefined,
    preserveUpstreamIdentity: typeof raw.preserveUpstreamIdentity === 'boolean' ? raw.preserveUpstreamIdentity : undefined,
    toolEmulationStrict: typeof raw.toolEmulationStrict === 'boolean' ? raw.toolEmulationStrict : undefined,
    pollIntervalMs: typeof raw.pollIntervalMs === 'number' && raw.pollIntervalMs > 0 ? Math.floor(raw.pollIntervalMs) : undefined,
    pollMaxWaitMs: typeof raw.pollMaxWaitMs === 'number' && raw.pollMaxWaitMs > 0 ? Math.floor(raw.pollMaxWaitMs) : undefined,
    lsPort: typeof raw.lsPort === 'number' && raw.lsPort > 0 ? Math.floor(raw.lsPort) : undefined,
    csrfToken: readNonEmptyString(raw.csrfToken),
    sessionId: readNonEmptyString(raw.sessionId),
    workspacePath: readNonEmptyString(raw.workspacePath),
    workspaceUri: readNonEmptyString(raw.workspaceUri),
  };
}

export function isWindsurfRuntimeIdentity(opts: {
  providerFamily?: string;
  providerId?: string;
  providerKey?: string;
  runtimeKey?: string;
  compatibilityProfile?: string;
}): boolean {
  const read = (v?: string): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const pf = read(opts.providerFamily);
  const pid = read(opts.providerId);
  const pkey = read(opts.providerKey);
  const rkey = read(opts.runtimeKey);
  const cp = read(opts.compatibilityProfile);
  return (
    cp === 'chat:windsurf' ||
    cp === WINDSURF_COMPATIBILITY_PROFILE ||
    pid === 'windsurf' ||
    pid.startsWith('windsurf.') ||
    pkey === 'windsurf' ||
    pkey.startsWith('windsurf.') ||
    rkey === 'windsurf' ||
    rkey.startsWith('windsurf.') ||
    pf === 'windsurf'
  );
}

// SSOT: WindsurfProvider-specific error code catalog (added 2026-06-05, /goal fallback-arch-audit Phase 2).
// Provider-specific 错误码必须在 provider contract 暴露，不允许散落 impl / chat-provider / parse-block。
export const WINDSURF_ERROR_CODES = Object.freeze({
  RATE_LIMITED: 'WINDSURF_RATE_LIMITED',
  SESSION_TOKEN_NOT_INITIALIZED: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
  ACCOUNT_CREDENTIAL_MISSING: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
  NO_PASSWORD_SET: 'WINDSURF_NO_PASSWORD_SET',
  POSTAUTH_FAILED: 'WINDSURF_POSTAUTH_FAILED',
  SESSION_TOKEN_MISSING: 'WINDSURF_SESSION_TOKEN_MISSING',
  CASCADE_NO_PROGRESS: 'WINDSURF_CASCADE_NO_PROGRESS'
} as const);

export type WindsurfErrorCodeValue = (typeof WINDSURF_ERROR_CODES)[keyof typeof WINDSURF_ERROR_CODES];

// Phase 2: provider-specific 不可恢复错误码集合（被 failure-policy 引用，禁止散落 Set）
export const WINDSURF_UNRECOVERABLE_CODES: ReadonlySet<WindsurfErrorCodeValue> = new Set<WindsurfErrorCodeValue>([
  WINDSURF_ERROR_CODES.SESSION_TOKEN_NOT_INITIALIZED,
  WINDSURF_ERROR_CODES.ACCOUNT_CREDENTIAL_MISSING,
  WINDSURF_ERROR_CODES.NO_PASSWORD_SET,
  WINDSURF_ERROR_CODES.POSTAUTH_FAILED,
  WINDSURF_ERROR_CODES.SESSION_TOKEN_MISSING,
  WINDSURF_ERROR_CODES.CASCADE_NO_PROGRESS
]);

// Phase 2: provider-specific 阻断型可恢复错误码集合
export const WINDSURF_BLOCKING_RECOVERABLE_CODES: ReadonlySet<WindsurfErrorCodeValue> = new Set<WindsurfErrorCodeValue>([
  WINDSURF_ERROR_CODES.RATE_LIMITED
]);

// Phase 3 (2026-06-05, /goal fallback-arch-audit): 专判 windsurf.managed.* provider traffic。
// executor / http-server-runtime-providers 不再允许直接用 startsWith('windsurf.managed.')。
// providerKey 或 runtimeKey 任一匹配即视为 managed traffic；其他 windsurf.* 流量不在此范围。
export function isWindsurfManagedProviderIdentity(opts: {
  providerKey?: string;
  runtimeKey?: string;
}): boolean {
  const read = (v?: string): string =>
    typeof v === 'string' ? v.trim().toLowerCase() : '';
  const pkey = read(opts.providerKey);
  const rkey = read(opts.runtimeKey);
  if (pkey === 'windsurf.managed') return true;
  if (pkey.startsWith('windsurf.managed.')) return true;
  if (rkey === 'windsurf.managed') return true;
  if (rkey.startsWith('windsurf.managed.')) return true;
  return false;
}
