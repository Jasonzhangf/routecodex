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
}>();

export const sessionStormBackoffGateState = new Map<string, Promise<void>>();

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export function resolveSessionStormBackoffScopes(metadata: Record<string, unknown>): string[] {
  const scopes: string[] = [];
  const sessionId = readString(metadata.sessionId);
  if (sessionId) {
    scopes.push(`session:${sessionId}`);
  }
  const conversationId = readString(metadata.conversationId);
  if (conversationId) {
    scopes.push(`conversation:${conversationId}`);
  }
  const workdir =
    readString(metadata.clientWorkdir)
    ?? readString(metadata.client_workdir)
    ?? readString(metadata.workdir)
    ?? readString(metadata.cwd);
  if (workdir) {
    scopes.push(`workdir:${workdir}`);
  }
  return scopes;
}

export function resolveSessionStormBackoffScope(metadata: Record<string, unknown>): string | undefined {
  return resolveSessionStormBackoffScopes(metadata)[0];
}

function isClientToolArgsInvalidStorm(error: unknown): boolean {
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

export function resolveSessionStormBackoffMaxMsForError(error?: unknown): number {
  if (isClientToolArgsInvalidStorm(error)) {
    return process.env.NODE_ENV === 'test' ? 1_000 : 5_000;
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return process.env.NODE_ENV === 'test' ? 1_000 : 5_000;
  }
  return resolveSessionStormBackoffMaxMs();
}

export function consumeSessionStormBackoffMs(key: string, error?: unknown): number {
  const now = Date.now();
  for (const [existingKey, state] of sessionStormBackoffState.entries()) {
    if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS) {
      sessionStormBackoffState.delete(existingKey);
    }
  }
  const previous = sessionStormBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < SESSION_STORM_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  const delayMs = Math.min(
    resolveSessionStormBackoffMaxMsForError(error),
    resolveSessionStormBackoffBaseMsForError(error) * Math.pow(2, Math.max(0, consecutive - 1))
  );
  sessionStormBackoffState.set(key, {
    consecutive,
    updatedAtMs: now,
    nextAllowedAtMs: now + delayMs
  });
  return delayMs;
}

export function peekSessionStormBackoffWaitMs(key: string): number {
  const state = sessionStormBackoffState.get(key);
  if (!state) {
    return 0;
  }
  const now = Date.now();
  if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS) {
    sessionStormBackoffState.delete(key);
    return 0;
  }
  return Math.max(0, state.nextAllowedAtMs - now);
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
