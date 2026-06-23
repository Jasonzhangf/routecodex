// Shared helper functions for provider snapshot modules
// feature_id: snapshot.stage_contract

import { resolveRccSnapshotsDirFromEnv } from '../../config/user-data-paths.js';
import { redactSensitiveData } from '../../utils/sensitive-redaction.js';

export function resolvePositiveIntegerFromEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = String(process.env[name] ?? '').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export function normalizeRequestId(requestId?: string): string {
  if (!requestId || typeof requestId !== 'string') {
    return `req_${Date.now()}`;
  }
  const trimmed = requestId.trim();
  if (!trimmed) {
    return `req_${Date.now()}`;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
  return sanitized || `req_${Date.now()}`;
}

export function normalizeProviderToken(value?: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function resolveEndpoint(entryEndpoint?: string): { endpoint: string; folder: string } {
  const ep = String(entryEndpoint || '').trim().toLowerCase();
  if (
    ep.includes('/v1/responses')
    || ep.includes('/responses.submit')
    || ep.includes('openai-responses')
    || ep === 'responses'
  ) {
    return { endpoint: '/v1/responses', folder: 'openai-responses' };
  }
  if (
    ep.includes('/v1/messages')
    || ep.includes('anthropic-messages')
    || ep === 'messages'
    || ep === 'anthropic'
  ) {
    return { endpoint: '/v1/messages', folder: 'anthropic-messages' };
  }
  return { endpoint: '/v1/chat/completions', folder: 'openai-chat' };
}

export function maskHeaders(headers: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers || typeof headers !== 'object') {
    return result;
  }
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      const raw = String(v ?? '');
      const masked = raw.length > 12 ? `${raw.slice(0, 6)}****${raw.slice(-6)}` : '****';
      result[k] = masked;
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function buildSnapshotPayload(options: {
  stage: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  extraMeta?: Record<string, unknown>;
}) {
  const redactedData = redactSensitiveData(options.data);
  const redactedHeaders = redactSensitiveData(maskHeaders(options.headers || {})) as Record<string, unknown>;
  return {
    meta: {
      stage: options.stage,
      version: String(process.env.ROUTECODEX_VERSION || 'dev'),
      buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString()),
      ...(options.extraMeta || {})
    },
    url: options.url,
    headers: redactedHeaders,
    ...(typeof redactedData === 'string' ? { bodyText: redactedData } : { body: redactedData })
  };
}

export function toErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function logSnapshotNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[provider-snapshot] ${operation} failed (non-blocking): ${reason}`);
}

export function resolveSnapshotBase(): string {
  return resolveRccSnapshotsDirFromEnv();
}
