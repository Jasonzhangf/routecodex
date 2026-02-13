export const DEEPSEEK_PROVIDER_FAMILY = 'deepseek';
export const DEEPSEEK_COMPATIBILITY_PROFILE = 'chat:deepseek-web';

export type DeepSeekToolCallState = 'native_tool_calls' | 'text_tool_calls' | 'no_tool_calls';
export type DeepSeekToolCallSource = 'native' | 'fallback' | 'none';

export const DEEPSEEK_ERROR_CODES = Object.freeze({
  AUTH_MISSING: 'DEEPSEEK_AUTH_MISSING',
  AUTH_INVALID: 'DEEPSEEK_AUTH_INVALID',
  SESSION_CREATE_FAILED: 'DEEPSEEK_SESSION_CREATE_FAILED',
  POW_CHALLENGE_FAILED: 'DEEPSEEK_POW_CHALLENGE_FAILED',
  POW_SOLVE_FAILED: 'DEEPSEEK_POW_SOLVE_FAILED',
  COMPLETION_FAILED: 'DEEPSEEK_COMPLETION_FAILED',
  TOOL_REQUIRED_MISSING: 'DEEPSEEK_TOOL_REQUIRED_MISSING'
} as const);

export type DeepSeekErrorCode = (typeof DEEPSEEK_ERROR_CODES)[keyof typeof DEEPSEEK_ERROR_CODES];

export interface DeepSeekProviderRuntimeOptions {
  strictToolRequired: boolean;
  textToolFallback: boolean;
  powTimeoutMs: number;
  powMaxAttempts: number;
  sessionReuseTtlMs: number;
}

const DEFAULT_DEEPSEEK_OPTIONS: DeepSeekProviderRuntimeOptions = {
  strictToolRequired: true,
  textToolFallback: true,
  powTimeoutMs: 15000,
  powMaxAttempts: 2,
  sessionReuseTtlMs: 30 * 60 * 1000
};

export interface DeepSeekRuntimeIdentity {
  providerFamily?: string;
  providerId?: string;
  providerKey?: string;
  compatibilityProfile?: string;
}

function readBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function readInteger(input: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof input === 'number' ? input : typeof input === 'string' ? Number.parseInt(input, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function getToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeDeepSeekProviderRuntimeOptions(input: unknown): DeepSeekProviderRuntimeOptions {
  const node = asRecord(input) ?? {};
  return {
    strictToolRequired: readBoolean(node.strictToolRequired, DEFAULT_DEEPSEEK_OPTIONS.strictToolRequired),
    textToolFallback: readBoolean(node.textToolFallback, DEFAULT_DEEPSEEK_OPTIONS.textToolFallback),
    powTimeoutMs: readInteger(node.powTimeoutMs, DEFAULT_DEEPSEEK_OPTIONS.powTimeoutMs, 1000, 120000),
    powMaxAttempts: readInteger(node.powMaxAttempts, DEFAULT_DEEPSEEK_OPTIONS.powMaxAttempts, 1, 10),
    sessionReuseTtlMs: readInteger(node.sessionReuseTtlMs, DEFAULT_DEEPSEEK_OPTIONS.sessionReuseTtlMs, 1000, 24 * 60 * 60 * 1000)
  };
}

export function isDeepSeekRuntimeIdentity(identity: DeepSeekRuntimeIdentity): boolean {
  const family = getToken(identity.providerFamily);
  if (family === DEEPSEEK_PROVIDER_FAMILY) {
    return true;
  }

  const providerId = getToken(identity.providerId);
  if (providerId === DEEPSEEK_PROVIDER_FAMILY || providerId.startsWith(`${DEEPSEEK_PROVIDER_FAMILY}.`)) {
    return true;
  }

  const providerKey = getToken(identity.providerKey);
  if (providerKey === DEEPSEEK_PROVIDER_FAMILY || providerKey.startsWith(`${DEEPSEEK_PROVIDER_FAMILY}.`)) {
    return true;
  }

  const profile = getToken(identity.compatibilityProfile);
  if (profile === DEEPSEEK_COMPATIBILITY_PROFILE) {
    return true;
  }

  return false;
}

export function readDeepSeekProviderRuntimeOptions(source: {
  runtimeOptions?: unknown;
  extensions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): DeepSeekProviderRuntimeOptions | undefined {
  const direct = asRecord(source.runtimeOptions);
  if (direct) {
    return normalizeDeepSeekProviderRuntimeOptions(direct);
  }

  const extNode = asRecord(source.extensions?.deepseek);
  if (extNode) {
    return normalizeDeepSeekProviderRuntimeOptions(extNode);
  }

  const metadataNode = asRecord(source.metadata?.deepseek);
  if (metadataNode) {
    return normalizeDeepSeekProviderRuntimeOptions(metadataNode);
  }

  return undefined;
}
