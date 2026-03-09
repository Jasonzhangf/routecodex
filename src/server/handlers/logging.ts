import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { colorizeRequestLog } from '../utils/request-log-color.js';

export type RequestLogMeta = Record<string, unknown> | undefined;

export function logRequestStart(endpoint: string, requestId: string, meta?: RequestLogMeta): void {
  void endpoint;
  void requestId;
  void meta;
}

export function logRequestComplete(endpoint: string, requestId: string, status: number, meta?: RequestLogMeta): void {
  const suffix = formatMeta(meta);
  const label = deriveRequestLabel(requestId, meta);
  const prefix = status >= 400 ? '❌' : '✅';
  const text = `${prefix} [${endpoint}] request ${label} completed (status=${status})${suffix}`;
  if (status >= 400) {
    console.error(colorizeRequestLog(text, label));
    return;
  }
  console.log(colorizeRequestLog(text, label));
}

export function logRequestError(endpoint: string, requestId: string, error: unknown, meta?: RequestLogMeta): void {
  const resolvedId = deriveRequestLabel(requestId, meta);
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const suffix = formatMeta(meta);
  const text = `❌ [${endpoint}] request ${resolvedId} failed: ${message}${suffix}`;
  console.error(colorizeRequestLog(text, resolvedId));
}

const HIDDEN_META_KEYS = new Set([
  'internalRequestId',
  'providerRequestId',
  'pipelineRequestId',
  'requestLabel',
  'clientRequestId'
]);

function deriveRequestLabel(requestId?: string, meta?: RequestLogMeta): string {
  const override = extractInternalRequestId(meta);
  if (override && !isUnknownRequestLabel(override)) {
    return resolveEffectiveRequestId(override);
  }
  const clientCandidate = typeof meta === 'object' && meta && typeof meta['clientRequestId'] === 'string'
    ? (meta['clientRequestId'] as string)
    : undefined;
  if (clientCandidate && clientCandidate.trim()) {
    return resolveEffectiveRequestId(clientCandidate.trim());
  }
  return resolveEffectiveRequestId(override || requestId);
}

function extractInternalRequestId(meta?: RequestLogMeta): string | undefined {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }
  const bag = meta as Record<string, unknown>;
  for (const key of ['internalRequestId', 'providerRequestId', 'pipelineRequestId', 'requestLabel']) {
    const candidate = bag[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isUnknownRequestLabel(value?: string): boolean {
  if (!value) {
    return true;
  }
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  return normalized === 'unknown' || normalized.includes('-unknown-');
}

function formatMeta(meta?: RequestLogMeta): string {
  if (!meta || typeof meta !== 'object') {
    return '';
  }
  const entries = Object.entries(meta)
    .filter(([key, value]) => !HIDDEN_META_KEYS.has(key) && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  return entries.length ? ` (${entries.join(', ')})` : '';
}
