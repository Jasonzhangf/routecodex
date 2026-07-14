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
function normalizeKey(key) {
    return String(key || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
}
function isSensitiveKey(key) {
    const normalized = normalizeKey(key);
    if (!normalized) {
        return false;
    }
    if (SENSITIVE_KEYS.has(normalized)) {
        return true;
    }
    return normalized.endsWith('token') && normalized !== 'tokenfile';
}
function isSafeSecretReference(value) {
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
function maskSecretValue(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return REDACTED;
    }
    return `${REDACTED}:${trimmed.length}`;
}
function redactEmbeddedSecrets(text) {
    let out = String(text || '');
    out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
    out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]');
    out = out.replace(/(\bapi[_-]?key\b\s*[:=]\s*)(["']?)[^"'\s,;]+(\2)/gi, '$1$2[REDACTED]$3');
    out = out.replace(/(\bpassword\b\s*[:=]\s*)(["']?)[^"'\s,;]+(\2)/gi, '$1$2[REDACTED]$3');
    out = out.replace(/(\bcookie\b\s*[:=]\s*)(["']?)[^"'\n]+(\2)/gi, '$1$2[REDACTED]$3');
    return out;
}
function redactByKey(value) {
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
function redactInternal(value, state, depth, keyHint) {
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
    if (state.has(value)) {
        return '[CIRCULAR]';
    }
    state.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => redactInternal(item, state, depth + 1));
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        out[key] = redactInternal(child, state, depth + 1, key);
    }
    return out;
}
export function redactSensitiveData(input) {
    return redactInternal(input, new WeakSet(), 0);
}
export function stringifyRedactedJson(input, space) {
    const seen = new WeakSet();
    const depths = new WeakMap();
    return JSON.stringify(input, function redactingReplacer(key, value) {
        const parentDepth = this && typeof this === 'object'
            ? depths.get(this)
            : undefined;
        const depth = key === '' ? 0 : (parentDepth ?? -1) + 1;
        if (depth > MAX_DEPTH) {
            return '[TRUNCATED_DEPTH]';
        }
        if (key && isSensitiveKey(key)) {
            return redactByKey(value);
        }
        if (typeof value === 'string') {
            return redactEmbeddedSecrets(value);
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        if (seen.has(value)) {
            return '[CIRCULAR]';
        }
        seen.add(value);
        depths.set(value, depth);
        return value;
    }, space) ?? 'null';
}
