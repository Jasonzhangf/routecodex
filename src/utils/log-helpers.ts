import { Buffer } from 'node:buffer';

const DEFAULT_ERROR_LOG_LIMIT = 500;
const RAW_CAPTURE_LIMIT = 1024;

function coerceToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      /* ignore serialization failure */
    }
  }
  return undefined;
}

function extractRawErrorPayload(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const bag = error as Record<string, unknown>;
  const candidates = ['raw', 'rawBody', 'rawResponse', 'responseBody', 'bodyText'];
  for (const key of candidates) {
    const value = bag[key];
    const text = coerceToString(value);
    if (text && text.trim()) {
      return text;
    }
  }
  const response = bag.response;
  if (response && typeof response === 'object') {
    const data = coerceToString((response as Record<string, unknown>).data);
    if (data && data.trim()) {
      return data;
    }
    const body = coerceToString((response as Record<string, unknown>).body);
    if (body && body.trim()) {
      return body;
    }
  }
  return undefined;
}

export function truncateForConsole(value: string, limit = DEFAULT_ERROR_LOG_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  const slice = value.slice(0, limit);
  return `${slice}...[truncated ${value.length - limit} chars]`;
}

export function formatErrorForConsole(
  error: unknown,
  limit = DEFAULT_ERROR_LOG_LIMIT
): { text: string } {
  // Improve VirtualRouterError diagnostics for "no providers" cases.
  // This is intentionally console-only: client error mapping remains unchanged.
  if (error && typeof error === 'object') {
    try {
      const bag = error as Record<string, unknown>;
      const code = typeof bag.code === 'string' ? bag.code.trim() : '';
      const details = bag.details && typeof bag.details === 'object' && !Array.isArray(bag.details)
        ? (bag.details as Record<string, unknown>)
        : null;
      const attemptedRaw =
        (details && Array.isArray(details.attempted) ? details.attempted : null) ??
        (Array.isArray(bag.attempted) ? bag.attempted : null);
      const attempted = Array.isArray(attemptedRaw)
        ? attemptedRaw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      if (code === 'PROVIDER_NOT_AVAILABLE' && attempted.length > 0) {
        const routeName =
          (details && typeof details.routeName === 'string' ? details.routeName.trim() : '') ||
          (typeof bag.routeName === 'string' ? bag.routeName.trim() : '');
        const head = attempted.slice(0, 12);
        const suffix = attempted.length > head.length ? ` …(+${attempted.length - head.length})` : '';
        const text = `${routeName ? `All providers unavailable for route ${routeName}` : 'All providers unavailable'} (attempted: ${head.join(', ')}${suffix})`;
        annotateErrorWithRaw(error, text);
        return { text: truncateForConsole(text, limit) };
      }
    } catch {
      // ignore: fall back to default formatting
    }
  }

  const raw = extractRawErrorPayload(error);
  if (raw) {
    annotateErrorWithRaw(error, raw);
    return { text: truncateForConsole(raw, limit) };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { text: truncateForConsole(message, limit) };
}

export function annotateErrorWithRaw(error: unknown, raw: string): void {
  if (!error || typeof error !== 'object') {
    return;
  }
  const bag = error as Record<string, unknown>;
  if (typeof raw === 'string' && raw.length) {
    if (!bag.rawError) {
      bag.rawError = raw;
    }
    if (!bag.rawErrorSnippet) {
      bag.rawErrorSnippet = truncateForConsole(raw, RAW_CAPTURE_LIMIT);
    }
  }
}

export function attachRawPayload(error: unknown, payload: string): void {
  const snippet = typeof payload === 'string' ? payload.slice(0, RAW_CAPTURE_LIMIT) : '';
  if (!snippet) {
    return;
  }
  annotateErrorWithRaw(error, snippet);
  if (error && typeof error === 'object') {
    (error as Record<string, unknown>).rawPayload = snippet;
  }
}
