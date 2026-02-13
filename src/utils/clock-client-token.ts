const CLOCK_DAEMON_KEY_DELIMITER = '::rcc-clockd:';

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

export function encodeClockClientApiKey(baseApiKey: string, daemonId: string): string {
  const base = normalizeToken(baseApiKey) || 'rcc-proxy-key';
  const normalizedDaemonId = normalizeDaemonId(daemonId);
  if (!normalizedDaemonId) {
    return base;
  }
  return `${base}${CLOCK_DAEMON_KEY_DELIMITER}${normalizedDaemonId}`;
}

export function extractClockClientDaemonIdFromApiKey(value: unknown): string | undefined {
  const apiKey = normalizeToken(value);
  if (!apiKey) {
    return undefined;
  }
  const markerIndex = apiKey.lastIndexOf(CLOCK_DAEMON_KEY_DELIMITER);
  if (markerIndex < 0) {
    return undefined;
  }
  const suffix = apiKey.slice(markerIndex + CLOCK_DAEMON_KEY_DELIMITER.length);
  const daemonId = normalizeDaemonId(suffix);
  return daemonId || undefined;
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
  return Boolean(daemonId);
}

