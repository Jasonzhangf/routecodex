import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { containsSyntheticRouteCodexControlTextWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { sanitizeFollowupText } from './handlers/followup-sanitize.js';
import { inspectStopGatewaySignal } from './stop-gateway-context.js';

const FOLLOWUP_ERROR_REASON_MAX_LENGTH = 220;

function parseTimeoutMs(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('parseTimeoutMs: invalid timeout value');
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
  const raw = process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS ||
    process.env.RCC_SERVERTOOL_TIMEOUT_MS ||
    process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS;
  if (!raw) return 0;
  return parseTimeoutMs(raw);
}

export function resolveServerToolFollowupTimeoutMs(): number {
  const raw = process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
    process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
    process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
  if (!raw) return 0;
  return parseTimeoutMs(raw);
}

export function readClientInjectOnly(metadata: JsonObject): boolean {
  const parsed = parseBooleanLike((metadata as Record<string, unknown>).clientInjectOnly);
  return parsed === true;
}

export function normalizeClientInjectText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('normalizeClientInjectText: value must be a non-empty string');
  }
  const sanitized = sanitizeFollowupText(value.trim());
  if (!sanitized) {
    throw new Error('normalizeClientInjectText: sanitized result is empty');
  }
  return sanitized;
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
  const direct =
    typeof record.targetProviderKey === 'string' && record.targetProviderKey.trim().length
      ? record.targetProviderKey.trim()
      : typeof record.providerKey === 'string' && record.providerKey.trim().length
        ? record.providerKey.trim()
        : '';
  if (direct) {
    return direct;
  }
  return '';
}

export function containsSyntheticRouteCodexControlText(value: unknown): boolean {
  return containsSyntheticRouteCodexControlTextWithNative(value);
}
