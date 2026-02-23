const CLOCK_DAEMON_KEY_DELIMITER = '::rcc-clockd:';
const CLOCK_TMUX_KEY_DELIMITER = '::rcc-tmux:';

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
  const nextDaemon = apiKey.indexOf(CLOCK_DAEMON_KEY_DELIMITER, start);
  const nextTmux = apiKey.indexOf(CLOCK_TMUX_KEY_DELIMITER, start);
  const candidates = [nextDaemon, nextTmux].filter((entry) => entry >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : apiKey.length;
  const value = apiKey.slice(start, end);
  return value || undefined;
}

export function encodeClockClientApiKey(baseApiKey: string, daemonId: string, tmuxSessionId?: string): string {
  const base = normalizeToken(baseApiKey) || 'rcc-proxy-key';
  const normalizedDaemonId = normalizeDaemonId(daemonId);
  const normalizedTmuxSessionId = normalizeTmuxSessionId(tmuxSessionId);
  let encoded = base;
  if (normalizedDaemonId) {
    encoded = `${encoded}${CLOCK_DAEMON_KEY_DELIMITER}${normalizedDaemonId}`;
  }
  if (normalizedTmuxSessionId) {
    encoded = `${encoded}${CLOCK_TMUX_KEY_DELIMITER}${normalizedTmuxSessionId}`;
  }
  return encoded;
}

export function extractClockClientDaemonIdFromApiKey(value: unknown): string | undefined {
  const apiKey = normalizeToken(value);
  if (!apiKey) {
    return undefined;
  }
  const suffix = extractSuffixValue(apiKey, CLOCK_DAEMON_KEY_DELIMITER);
  if (!suffix) {
    return undefined;
  }
  const daemonId = normalizeDaemonId(suffix);
  return daemonId || undefined;
}

export function extractClockClientTmuxSessionIdFromApiKey(value: unknown): string | undefined {
  const apiKey = normalizeToken(value);
  if (!apiKey) {
    return undefined;
  }
  const suffix = extractSuffixValue(apiKey, CLOCK_TMUX_KEY_DELIMITER);
  if (!suffix) {
    return undefined;
  }
  const tmuxSessionId = normalizeTmuxSessionId(suffix);
  return tmuxSessionId || undefined;
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
  if (!provided.startsWith(expected)) {
    return false;
  }
  const daemonId = extractClockClientDaemonIdFromApiKey(provided);
  if (daemonId) {
    return true;
  }
  const tmuxSessionId = extractClockClientTmuxSessionIdFromApiKey(provided);
  return Boolean(tmuxSessionId);
}
