export function parseString(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || undefined;
}

export function parseBoolean(input: unknown): boolean | undefined {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

export function isSessionManagedTerminationEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_SESSION_REAPER_TERMINATE_MANAGED
      ?? process.env.RCC_SESSION_REAPER_TERMINATE_MANAGED
      ?? ''
  ).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return false;
}

export function parsePositiveInt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function isLocalCallbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

export function validateSessionClientCallbackUrl(input: string): { ok: true; normalizedUrl: string } | { ok: false; reason: string } {
  const value = parseString(input);
  if (!value) {
    return { ok: false, reason: 'callbackUrl is required' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'callbackUrl must be a valid URL' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'callbackUrl protocol must be http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'callbackUrl must not include username/password' };
  }
  if (!isLocalCallbackHost(parsed.hostname)) {
    return { ok: false, reason: 'callbackUrl host must be localhost/loopback' };
  }
  if (!parsed.port) {
    return { ok: false, reason: 'callbackUrl must include an explicit port' };
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'callbackUrl port is invalid' };
  }
  return { ok: true, normalizedUrl: parsed.toString() };
}
