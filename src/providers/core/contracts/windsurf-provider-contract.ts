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
