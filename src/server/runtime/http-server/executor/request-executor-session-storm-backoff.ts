import {
  readString,
  normalizeCodeKey
} from './request-executor-error-shared.js';
import {
  extractStatusCodeFromError
} from './utils.js';
import {
  waitWithClientAbortSignal
} from './request-executor-abort.js';

const SESSION_STORM_BACKOFF_TTL_MS = 10 * 60_000;

const sessionStormBackoffState = new Map<string, {
  consecutive: number;
  updatedAtMs: number;
  nextAllowedAtMs: number;
  hardBlock?: boolean;
  code?: string;
  upstreamCode?: string;
  reason?: string;
}>();

export const sessionStormBackoffGateState = new Map<string, Promise<void>>();

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export function resolveSessionStormBackoffScopes(metadata: Record<string, unknown>): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  const pushScope = (value: string | undefined): void => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    scopes.push(normalized);
  };
  const sessionId = readString(metadata.sessionId);
  if (sessionId) {
    pushScope(`session:${sessionId}`);
  }
  const conversationId = readString(metadata.conversationId);
  if (conversationId) {
    pushScope(`conversation:${conversationId}`);
  }
  const workdir =
    readString(metadata.clientWorkdir)
    ?? readString(metadata.client_workdir)
    ?? readString(metadata.workdir)
    ?? readString(metadata.cwd);
  if (workdir) {
    pushScope(`workdir:${workdir}`);
  }
  // Fallback scope for requests that do not carry session/conversation/workdir
  // (common for some clients that only send API key / daemon id metadata).
  const daemonScope =
    readString(metadata.sessionClientDaemonId)
    ?? readString(metadata.session_client_daemon_id)
    ?? readString(metadata.clientDaemonId)
    ?? readString(metadata.client_daemon_id)
    ?? readString(metadata.sessionDaemonId)
    ?? readString(metadata.session_daemon_id);
  if (daemonScope) {
    pushScope(`daemon:${daemonScope}`);
  }
  const clientType = readString(metadata.sessionClientType) ?? readString(metadata.clientType);
  if (!scopes.length && clientType) {
    // Last-resort anti-storm fence: keep blast radius small to current client type
    // when no stable scope token is available at all.
    pushScope(`clientType:${clientType}`);
  }
  if (!scopes.length) {
    pushScope('anonymous');
  }
  return scopes;
}

export function resolveSessionStormBackoffScope(metadata: Record<string, unknown>): string | undefined {
  return resolveSessionStormBackoffScopes(metadata)[0];
}

export function isClientToolArgsInvalidStorm(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; upstreamCode?: unknown; message?: unknown };
  const code = normalizeCodeKey(record.code);
  const upstreamCode = normalizeCodeKey(record.upstreamCode);
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return (
    code === 'CLIENT_TOOL_ARGS_INVALID'
    || upstreamCode === 'CLIENT_TOOL_ARGS_INVALID'
    || (code === 'SERVERTOOL_FOLLOWUP_FAILED' && upstreamCode === 'CLIENT_TOOL_ARGS_INVALID')
    || message.includes('converted provider tool call has invalid client arguments')
  );
}

function isDeterministicMalformedResponseStorm(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; upstreamCode?: unknown; message?: unknown; reason?: unknown };
  const code = normalizeCodeKey(record.code);
  const upstreamCode = normalizeCodeKey(record.upstreamCode);
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  const reason = typeof record.reason === 'string' ? record.reason.toLowerCase() : '';
  if (code !== 'MALFORMED_RESPONSE' && upstreamCode !== 'MALFORMED_RESPONSE') {
    return false;
  }
  return (
    message.includes('[hub_response] non-canonical response payload')
    || message.includes('[hub_response] failed to canonicalize response payload')
    || message.includes('[servertool] tool_call missing required id')
    || reason.includes('missing_tool_call_id')
    || reason.includes('tool_call missing required id')
  );
}

function isDeterministicNoProviderStorm(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; upstreamCode?: unknown; message?: unknown };
  const code = normalizeCodeKey(record.code);
  const upstreamCode = normalizeCodeKey(record.upstreamCode);
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  if (code !== 'PROVIDER_NOT_AVAILABLE' && upstreamCode !== 'PROVIDER_NOT_AVAILABLE') {
    return false;
  }
  return (
    message.includes('no available providers after applying routing instructions')
    || message.includes('no provider target selected')
  );
}

export function isSessionStormBackoffCandidate(error: unknown): boolean {
  if (isClientToolArgsInvalidStorm(error)) {
    return true;
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return true;
  }
  const codeSource =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  const code = normalizeCodeKey(codeSource);
  if (code === 'PROVIDER_NOT_AVAILABLE' || code === 'ERR_NO_PROVIDER_TARGET') {
    return true;
  }
  const status = extractStatusCodeFromError(error);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? String((error as { message?: unknown }).message)
        : String(error ?? '');
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('fetch failed')
    || normalized.includes('all providers unavailable')
    || normalized.includes('no available providers after applying routing instructions')
    || normalized.includes('connect timeout')
    || normalized.includes('request timeout')
  );
}

export function resolveSessionStormBackoffBaseMs(): number {
  const raw =
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS
    ?? process.env.RCC_SESSION_STORM_BACKOFF_BASE_MS
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return process.env.NODE_ENV === 'test' ? 200 : 1_000;
}

export function resolveSessionStormBackoffBaseMsForError(error?: unknown): number {
  if (isClientToolArgsInvalidStorm(error)) {
    return process.env.NODE_ENV === 'test' ? 200 : 1_000;
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return process.env.NODE_ENV === 'test' ? 200 : 1_000;
  }
  return resolveSessionStormBackoffBaseMs();
}

export function resolveSessionStormBackoffMaxMs(): number {
  const raw =
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS
    ?? process.env.RCC_SESSION_STORM_BACKOFF_MAX_MS
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return process.env.NODE_ENV === 'test' ? 5_000 : 30_000;
}

export function resolveSessionStormHardBlockMsForError(error?: unknown): number {
  if (isClientToolArgsInvalidStorm(error)) {
    const raw =
      process.env.ROUTECODEX_SESSION_STORM_HARD_BLOCK_MS
      ?? process.env.RCC_SESSION_STORM_HARD_BLOCK_MS
      ?? '';
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 1_000 : 60_000;
  }
  if (isDeterministicNoProviderStorm(error)) {
    const raw =
      process.env.ROUTECODEX_SESSION_STORM_NO_PROVIDER_BLOCK_MS
      ?? process.env.RCC_SESSION_STORM_NO_PROVIDER_BLOCK_MS
      ?? '';
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return process.env.NODE_ENV === 'test' ? 500 : 15_000;
  }
  return 0;
}

export function resolveSessionStormBackoffMaxMsForError(error?: unknown): number {
  if (isClientToolArgsInvalidStorm(error)) {
    return resolveSessionStormHardBlockMsForError(error) || (process.env.NODE_ENV === 'test' ? 1_000 : 5_000);
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return process.env.NODE_ENV === 'test' ? 1_000 : 5_000;
  }
  return resolveSessionStormBackoffMaxMs();
}

function pruneExpiredSessionStormBackoff(now = Date.now()): void {
  for (const [existingKey, state] of sessionStormBackoffState.entries()) {
    if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS || state.nextAllowedAtMs <= now) {
      sessionStormBackoffState.delete(existingKey);
    }
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? String((error as { message?: unknown }).message)
      : String(error ?? '');
}

export function consumeSessionStormBackoffMs(key: string, error?: unknown): number {
  const now = Date.now();
  pruneExpiredSessionStormBackoff(now);
  const previous = sessionStormBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < SESSION_STORM_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  const hardBlockMs = resolveSessionStormHardBlockMsForError(error);
  const delayMs = hardBlockMs > 0
    ? hardBlockMs
    : Math.min(
      resolveSessionStormBackoffMaxMsForError(error),
      resolveSessionStormBackoffBaseMsForError(error) * Math.pow(2, Math.max(0, consecutive - 1))
    );
  const errorRecord = error && typeof error === 'object' ? error as { code?: unknown; upstreamCode?: unknown } : {};
  sessionStormBackoffState.set(key, {
    consecutive,
    updatedAtMs: now,
    nextAllowedAtMs: now + delayMs,
    ...(hardBlockMs > 0 ? { hardBlock: true } : {}),
    ...(normalizeCodeKey(errorRecord.code) ? { code: normalizeCodeKey(errorRecord.code) } : {}),
    ...(normalizeCodeKey(errorRecord.upstreamCode) ? { upstreamCode: normalizeCodeKey(errorRecord.upstreamCode) } : {}),
    ...(readErrorMessage(error) ? { reason: readErrorMessage(error).slice(0, 300) } : {})
  });
  return delayMs;
}

export function peekSessionStormBackoffWaitMs(key: string): number {
  const state = sessionStormBackoffState.get(key);
  if (!state) {
    return 0;
  }
  const now = Date.now();
  if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS || state.nextAllowedAtMs <= now) {
    sessionStormBackoffState.delete(key);
    return 0;
  }
  return Math.max(0, state.nextAllowedAtMs - now);
}

export function buildSessionStormHardBlockError(key: string): Error | undefined {
  const waitMs = peekSessionStormBackoffWaitMs(key);
  const state = sessionStormBackoffState.get(key);
  if (!state?.hardBlock || !(waitMs > 0)) {
    return undefined;
  }
  const sourceCode = state.upstreamCode || state.code || '';
  const isToolArgs = sourceCode === 'CLIENT_TOOL_ARGS_INVALID';
  const blockCode = isToolArgs ? 'CLIENT_TOOL_ARGS_BLOCKED' : 'SESSION_STORM_BLOCKED';
  const message = isToolArgs
    ? `Request blocked because this scope recently produced invalid client tool arguments. waitMs=${waitMs}`
    : `Request blocked because this scope is in deterministic error storm cooldown. waitMs=${waitMs}`;
  const err = new Error(message) as Error & {
    code?: string;
    upstreamCode?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  err.code = blockCode;
  err.upstreamCode = sourceCode || 'SESSION_STORM_BLOCKED';
  err.status = 429;
  err.statusCode = 429;
  err.retryable = false;
  err.details = {
    scope: key,
    waitMs,
    consecutive: state.consecutive,
    reason: state.reason,
    sourceCode,
    sourceUpstreamCode: state.upstreamCode
  };
  return err;
}

export function clearSessionStormBackoff(key?: string): void {
  if (!key) {
    return;
  }
  sessionStormBackoffState.delete(key);
}

export function peekSessionStormBackoffConsecutiveForTests(key: string): number {
  return sessionStormBackoffState.get(key)?.consecutive ?? 0;
}

export function peekSessionStormBackoffWaitMsForTests(key: string): number {
  return peekSessionStormBackoffWaitMs(key);
}

export function resetSessionStormBackoffStateForTests(): void {
  sessionStormBackoffState.clear();
  sessionStormBackoffGateState.clear();
}

export async function waitSessionStormBackoffWithGate(
  key: string,
  ms: number,
  signal?: AbortSignal,
  logNonBlockingError: LogNonBlockingError = () => undefined
): Promise<void> {
  if (!(ms > 0)) {
    return;
  }
  const normalizedKey = key.trim() || 'session:unknown';
  const previous = sessionStormBackoffGateState.get(normalizedKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionStormBackoffGateState.set(normalizedKey, current);
  try {
    await previous.catch((error: unknown) => {
      logNonBlockingError('waitSessionStormBackoffWithGate.previous', error, {
        key: normalizedKey
      });
    });
    await waitWithClientAbortSignal(ms, signal, logNonBlockingError);
  } finally {
    release();
    if (sessionStormBackoffGateState.get(normalizedKey) === current) {
      sessionStormBackoffGateState.delete(normalizedKey);
    }
  }
}
