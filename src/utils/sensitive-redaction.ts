const REDACTED = '[REDACTED]';
const MAX_DEPTH = 20;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'apikey',
  'apikeyvalue',
  'apikeyheader',
  'api_key',
  'api-key',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'sessiontoken',
  'tokenvalue',
  'bearertoken',
  'password',
  'passwd',
  'passcode',
  'secret',
  'clientsecret',
  'client_secret',
  'cookie',
  'setcookie'
]);

function normalizeKey(key: string): string {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return normalized.endsWith('token') && normalized !== 'tokenfile';
}

function isSafeSecretReference(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('authfile-')) {
    return true;
  }
  if (/^\$\{[A-Z0-9_]+\}$/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return true;
  }
  return false;
}

function maskSecretValue(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return REDACTED;
  }
  return `${REDACTED}:${trimmed.length}`;
}

function redactEmbeddedSecrets(text: string): string {
  let out = String(text || '');
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  out = out.replace(/\bsk-[A-Za-z0-9]{12,}\b/g, 'sk-[REDACTED]');
  out = out.replace(/(\bapi[_-]?key\b\s*[:=]\s*)(["']?)[^"'\s,;]+(\2)/gi, '$1$2[REDACTED]$3');
  out = out.replace(/(\bpassword\b\s*[:=]\s*)(["']?)[^"'\s,;]+(\2)/gi, '$1$2[REDACTED]$3');
  out = out.replace(/(\bcookie\b\s*[:=]\s*)(["']?)[^"'\n]+(\2)/gi, '$1$2[REDACTED]$3');
  return out;
}

function redactByKey(value: unknown): unknown {
  if (typeof value === 'string') {
    if (isSafeSecretReference(value)) {
      return value;
    }
    return maskSecretValue(value);
  }
  if (value == null) {
    return REDACTED;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return REDACTED;
  }
  return REDACTED;
}

function redactInternal(
  value: unknown,
  state: WeakSet<object>,
  depth: number,
  keyHint?: string
): unknown {
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED_DEPTH]';
  }

  if (keyHint && isSensitiveKey(keyHint)) {
    return redactByKey(value);
  }

  if (typeof value === 'string') {
    return redactEmbeddedSecrets(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (state.has(value as object)) {
    return '[CIRCULAR]';
  }
  state.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, state, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactInternal(child, state, depth + 1, key);
  }
  return out;
}

export function redactSensitiveData(input: unknown): unknown {
  return redactInternal(input, new WeakSet<object>(), 0);
}
