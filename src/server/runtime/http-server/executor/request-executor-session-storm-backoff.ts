/**
 * feature_id: error.session_storm_boundary
 */
import {
  readString,
  normalizeCodeKey
} from './request-executor-error-shared.js';
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';
import {
  extractStatusCodeFromError
} from './utils.js';
import {
  peekErrorActionBackoffConsecutiveForTests,
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  resetErrorActionBackoff,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} from './request-executor-error-action-queue.js';

const SESSION_STORM_BACKOFF_TTL_MS = 10 * 60_000;

const sessionStormBackoffState = new Map<string, {
  updatedAtMs: number;
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
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const sessionId = readString(requestTruth.sessionId);
  if (sessionId) {
    pushScope(`session:${sessionId}`);
  }
  const conversationId = readString(requestTruth.conversationId);
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
  if (error == null) {
    return false;
  }
  if (isClientToolArgsInvalidStorm(error)) {
    return true;
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return true;
  }
  const status = extractStatusCodeFromError(error);
  const codeSource =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? String((error as { message?: unknown }).message)
        : String(error ?? '');
  const known = normalizeKnownProviderError({
    statusCode: status,
    code: normalizeCodeKey(codeSource),
    upstreamCode: error && typeof error === 'object' ? (error as { upstreamCode?: unknown }).upstreamCode : undefined,
    message,
  });
  if (known) {
    return false;
  }
  return false;
}

export function resolveSessionStormBackoffBaseMs(): number {
  return 1_000;
}

export function resolveSessionStormBackoffBaseMsForError(error?: unknown): number {
  if (isClientToolArgsInvalidStorm(error)) {
    return resolveSessionStormBackoffBaseMs();
  }
  if (isDeterministicMalformedResponseStorm(error)) {
    return resolveSessionStormBackoffBaseMs();
  }
  return resolveSessionStormBackoffBaseMs();
}

export function resolveSessionStormBackoffMaxMs(): number {
  return 3_000;
}

export function resolveSessionStormHardBlockMsForError(error?: unknown): number {
  void error;
  return 0;
}

export function resolveSessionStormBackoffMaxMsForError(error?: unknown): number {
  if (isDeterministicMalformedResponseStorm(error)) {
    return 3_000;
  }
  return resolveSessionStormBackoffMaxMs();
}

function pruneExpiredSessionStormBackoff(now = Date.now()): void {
  for (const [existingKey, state] of sessionStormBackoffState.entries()) {
    if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS) {
      sessionStormBackoffState.delete(existingKey);
      resetErrorActionBackoff({
        category: 'session_storm',
        scopeKey: existingKey
      });
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
  const hardBlock = isClientToolArgsInvalidStorm(error);
  const delayMs = recordErrorActionBackoff({
    category: 'session_storm',
    scopeKey: key
  });
  const errorRecord = error && typeof error === 'object' ? error as { code?: unknown; upstreamCode?: unknown } : {};
  sessionStormBackoffState.set(key, {
    updatedAtMs: now,
    ...(hardBlock ? { hardBlock: true } : {}),
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
  if (now - state.updatedAtMs >= SESSION_STORM_BACKOFF_TTL_MS) {
    sessionStormBackoffState.delete(key);
    resetErrorActionBackoff({
      category: 'session_storm',
      scopeKey: key
    });
    return 0;
  }
  return peekErrorActionBackoffWaitMs({
    category: 'session_storm',
    scopeKey: key
  });
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
    consecutive: peekErrorActionBackoffConsecutiveForTests({
      category: 'session_storm',
      scopeKey: key
    }),
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
  resetErrorActionBackoff({
    category: 'session_storm',
    scopeKey: key
  });
}

export function peekSessionStormBackoffConsecutiveForTests(key: string): number {
  return peekErrorActionBackoffConsecutiveForTests({
    category: 'session_storm',
    scopeKey: key
  });
}

export function peekSessionStormBackoffWaitMsForTests(key: string): number {
  return peekSessionStormBackoffWaitMs(key);
}

export function resetSessionStormBackoffStateForTests(): void {
  sessionStormBackoffState.clear();
  sessionStormBackoffGateState.clear();
  resetErrorActionQueueStateForTests();
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
  await waitErrorActionBackoffWithGate({
    category: 'session_storm',
    scopeKey: key,
    ms,
    signal,
    logNonBlockingError
  });
}
