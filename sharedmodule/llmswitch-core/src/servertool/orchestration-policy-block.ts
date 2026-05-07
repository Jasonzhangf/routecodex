import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { isSyntheticRouteCodexControlText } from '../conversion/shared/openai-message-normalize.js';
import { findNextUndeliveredDueAtMs, listClockTasks, resolveClockConfig } from './clock/task-store.js';
import { resolveClockSessionScope } from './clock/session-scope.js';
import { sanitizeFollowupText } from './handlers/followup-sanitize.js';
import { inspectStopGatewaySignal } from './stop-gateway-context.js';

const FOLLOWUP_ERROR_REASON_MAX_LENGTH = 220;

function parseTimeoutMs(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
}

function isStopFinishReasonWithoutToolCalls(base: unknown): boolean {
  return inspectStopGatewaySignal(base).eligible;
}

export function resolveServerToolTimeoutMs(): number {
  return parseTimeoutMs(
    process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS ||
      process.env.RCC_SERVERTOOL_TIMEOUT_MS ||
      process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS,
    0
  );
}

export function resolveServerToolFollowupTimeoutMs(_fallback: number): number {
  return parseTimeoutMs(
    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
      process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
      process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS,
    0
  );
}

export function readClientInjectOnly(metadata: JsonObject): boolean {
  const parsed = parseBooleanLike((metadata as Record<string, unknown>).clientInjectOnly);
  return parsed === true;
}

export function normalizeClientInjectText(value: unknown, fallback = '继续执行'): string {
  const text =
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : fallback;
  const sanitized = sanitizeFollowupText(text);
  return sanitized || fallback;
}

export function compactFollowupErrorReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  const httpCodeMatch =
    normalized.match(/^http\s+(\d{3})\s*:/i) ||
    normalized.match(/\bhttp\s+(\d{3})\b/i);
  if (httpCodeMatch?.[1]) {
    return `HTTP_${httpCodeMatch[1]}`;
  }
  if (/<\s*!doctype\s+html\b/i.test(normalized) || /<\s*html\b/i.test(normalized)) {
    return 'UPSTREAM_HTML_ERROR';
  }
  if (normalized.length <= FOLLOWUP_ERROR_REASON_MAX_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, FOLLOWUP_ERROR_REASON_MAX_LENGTH) + '...';
}

export function resolveAdapterContextProviderKey(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const direct =
    typeof record.providerKey === 'string' && record.providerKey.trim().length
      ? record.providerKey.trim()
      : typeof record.targetProviderKey === 'string' && record.targetProviderKey.trim().length
        ? record.targetProviderKey.trim()
        : '';
  if (direct) {
    return direct;
  }
  const target =
    record.target && typeof record.target === 'object' && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : null;
  if (target) {
    const targetProviderKey =
      typeof target.providerKey === 'string' && target.providerKey.trim().length
        ? target.providerKey.trim()
        : typeof target.providerId === 'string' && target.providerId.trim().length
          ? target.providerId.trim()
          : '';
    if (targetProviderKey) {
      return targetProviderKey;
    }
  }
  return '';
}

export function containsSyntheticRouteCodexControlText(value: unknown): boolean {
  if (typeof value === 'string') {
    return isSyntheticRouteCodexControlText(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSyntheticRouteCodexControlText(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value as Record<string, unknown>)
    .some((entry) => containsSyntheticRouteCodexControlText(entry));
}

export async function shouldDisableServerToolTimeoutForClockHold(args: {
  chat: JsonObject;
  adapterContext: AdapterContext;
  serverToolTimeoutMs: number;
  requestId?: string;
}): Promise<boolean> {
  if (!isStopFinishReasonWithoutToolCalls(args.chat)) {
    return false;
  }
  const record = args.adapterContext as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  const sessionId = resolveClockSessionScope(record, rt as Record<string, unknown>);
  if (!sessionId) {
    return false;
  }
  const clockConfig = resolveClockConfig((rt as { clock?: unknown }).clock);
  if (!clockConfig) {
    return false;
  }
  try {
    const tasks = await listClockTasks(sessionId, clockConfig);
    const at = Date.now();
    const nextDueAtMs = findNextUndeliveredDueAtMs(tasks, at);
    if (!nextDueAtMs) {
      return false;
    }
    const thresholdMs = nextDueAtMs - clockConfig.dueWindowMs;
    if (thresholdMs <= at) {
      return false;
    }
    if (args.serverToolTimeoutMs > 0 && thresholdMs - at <= args.serverToolTimeoutMs) {
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = new ProviderProtocolError('[servertool] clock hold timeout probe failed', {
      code: 'SERVERTOOL_CLOCK_HOLD_TIMEOUT_PROBE_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: args.requestId,
        sessionId,
        serverToolTimeoutMs: args.serverToolTimeoutMs,
        reason: message
      }
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}
