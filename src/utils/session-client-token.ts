const SESSION_DAEMON_KEY_DELIMITER = '::rcc-sessiond:';
const SESSION_SCOPE_KEY_DELIMITER = '::rcc-session:';

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeDaemonId(value: unknown): string {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return '';
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    return '';
  }
  return normalized;
}

function normalizeTmuxSessionId(value: unknown): string {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return '';
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    return '';
  }
  return normalized;
}

function extractSuffixValue(apiKey: string, marker: string): string | undefined {
  const markerIndex = apiKey.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const start = markerIndex + marker.length;
  const nextDaemon = apiKey.indexOf(SESSION_DAEMON_KEY_DELIMITER, start);
  const nextScope = apiKey.indexOf(SESSION_SCOPE_KEY_DELIMITER, start);
  const candidates = [nextDaemon, nextScope].filter((entry) => entry >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : apiKey.length;
  const value = apiKey.slice(start, end);
  return value || undefined;
}

export function encodeSessionClientApiKey(baseApiKey: string, daemonId: string, sessionScopeId?: string): string {
  const base = normalizeToken(baseApiKey) || 'rcc-proxy-key';
  const normalizedDaemonId = normalizeDaemonId(daemonId);
  const normalizedScopeId = normalizeTmuxSessionId(sessionScopeId);
  let encoded = base;
  if (normalizedDaemonId) {
    encoded = `${encoded}${SESSION_DAEMON_KEY_DELIMITER}${normalizedDaemonId}`;
  }
  if (normalizedScopeId) {
    encoded = `${encoded}${SESSION_SCOPE_KEY_DELIMITER}${normalizedScopeId}`;
  }
  return encoded;
}

export function extractSessionClientDaemonIdFromApiKey(value: unknown): string | undefined {
  const apiKey = normalizeToken(value);
  if (!apiKey) {
    return undefined;
  }
  const suffix = extractSuffixValue(apiKey, SESSION_DAEMON_KEY_DELIMITER);
  if (!suffix) {
    return undefined;
  }
  const daemonId = normalizeDaemonId(suffix);
  return daemonId || undefined;
}

export function extractSessionClientScopeIdFromApiKey(value: unknown): string | undefined {
  const apiKey = normalizeToken(value);
  if (!apiKey) {
    return undefined;
  }
  const suffix = extractSuffixValue(apiKey, SESSION_SCOPE_KEY_DELIMITER);
  if (!suffix) {
    return undefined;
  }
  const scopeId = normalizeTmuxSessionId(suffix);
  return scopeId || undefined;
}

export function matchesExpectedClientApiKey(providedApiKey: string, expectedApiKey: string): boolean {
  const provided = normalizeToken(providedApiKey);
  const expected = normalizeToken(expectedApiKey);
  if (!provided || !expected) {
    return false;
  }
  if (provided === expected) {
    return true;
  }
  if (provided.startsWith(expected)) {
    return true;
  }
  return false;
}
