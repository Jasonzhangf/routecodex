import path from 'node:path';

export type WindsurfManagedAuthConfig = {
  apiKey?: string;
  rawType?: string;
  mobile?: string;
  account?: string;
  username?: string;
  password?: string;
  tokenFile?: string;
  accountAlias?: string;
  accountFile?: string;
  entries?: unknown[];
};

export type WindsurfSessionCredential = {
  apiKey: string;
  sessionToken: string;
  auth1Token: string;
  accountId?: string;
  primaryOrgId?: string;
  accountAlias?: string;
};

export type WindsurfPersistedCredentialParseResult =
  | { ok: true; credential: WindsurfSessionCredential; reason: 'session_token' }
  | { ok: true; credential: null; reason: 'missing' | 'not_session_token' }
  | { ok: false; error: Error; reason: 'read_failed' | 'malformed' };

export type WindsurfPersistedCredentialLoadResult = WindsurfPersistedCredentialParseResult;

export type WindsurfCredentialAuthStrategy = {
  passwordLoginAvailable: boolean;
};

export type WindsurfPostAuthEndpointStrategy = {
  name: 'app_backend_then_self_serve';
  endpoints: string[];
};

export type WindsurfPostAuthEndpointAttemptResult =
  | { ok: true; endpoint: string; response: Response }
  | { ok: false; endpoint: string; error: unknown };

export type WindsurfPostAuthEndpointSelectionResult =
  | { ok: true; strategy: string; endpoint: string; response: Response; attempts: WindsurfPostAuthEndpointAttemptResult[] }
  | { ok: false; strategy: string; attempts: WindsurfPostAuthEndpointAttemptResult[]; error: unknown };

export type WindsurfLoginMethodParseResult = { userExists: boolean; hasPassword: boolean };
export type WindsurfLoginMethodPayloadParseResult =
  | { ok: true; value: WindsurfLoginMethodParseResult }
  | { ok: false; reason: 'empty_body' | 'invalid_json' | 'unexpected_shape' };
export type WindsurfLoginMethodFetchResult =
  | { ok: true; probe: { method: 'auth1' | null; hasPassword: boolean } }
  | {
      ok: false;
      reason: 'http_non_ok' | 'payload_invalid' | 'transport_error';
      status?: number;
      parseReason?: 'empty_body' | 'invalid_json' | 'unexpected_shape';
      error?: string;
    };

export type WindsurfPostAuthPayloadParseResult = {
  sessionToken?: string;
  accountId?: string;
  primaryOrgId?: string;
  error?: string;
};

export type WindsurfInlineAccountParseResult =
  | { ok: true; email: string; passwordOrToken: string }
  | { ok: false; reason: 'not_string' | 'missing_separator' };

type WindsurfProtoVarintParseResult =
  | { ok: true; value: number; consumed: number }
  | { ok: false; reason: 'shift_overflow' | 'unexpected_eof' };

function decodeProtoVarintDetailed(bytes: Uint8Array, offset: number): WindsurfProtoVarintParseResult {
  let result = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { ok: true, value: result, consumed: index - offset + 1 };
    }
    shift += 7;
    if (shift > 35) return { ok: false, reason: 'shift_overflow' };
  }
  return { ok: false, reason: 'unexpected_eof' };
}

export function keyLikeSessionToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('devin-session-token$');
}

export function parseInlineWindsurfAccountDetailed(value: unknown): WindsurfInlineAccountParseResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'not_string' };
  }
  const trimmed = value.trim();
  const idx = trimmed.indexOf('|');
  if (idx <= 0 || idx >= trimmed.length - 1) {
    return { ok: false, reason: 'missing_separator' };
  }
  return {
    ok: true,
    email: trimmed.slice(0, idx).trim(),
    passwordOrToken: trimmed.slice(idx + 1).trim(),
  };
}

export function normalizeWindsurfAuthRawType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isManagedWindsurfAuthRawType(rawType: string): boolean {
  return rawType === 'windsurf-account' || rawType === 'windsurf-devin-token';
}

export function resolveManagedCredentialAuthStrategy(cfg: WindsurfManagedAuthConfig): WindsurfCredentialAuthStrategy {
  const mobile = typeof cfg.mobile === 'string' ? cfg.mobile.trim() : '';
  const account = typeof cfg.account === 'string' ? cfg.account.trim() : '';
  const username = typeof cfg.username === 'string' ? cfg.username.trim() : '';
  const password = typeof cfg.password === 'string' ? cfg.password.trim() : '';
  const parsedInline = parseInlineWindsurfAccountDetailed(cfg.apiKey);
  const loginEmail = mobile || account || username || (parsedInline.ok ? parsedInline.email : '') || '';
  const loginPassword = password || (parsedInline.ok ? parsedInline.passwordOrToken : '') || '';
  return { passwordLoginAvailable: !!(loginEmail && loginPassword) };
}

export function buildWindsurfPostAuthEndpointStrategy(appBackendEndpoint: string, selfServeEndpoint: string): WindsurfPostAuthEndpointStrategy {
  return {
    name: 'app_backend_then_self_serve',
    endpoints: [appBackendEndpoint, selfServeEndpoint],
  };
}

export async function selectWindsurfPostAuthEndpoint(args: {
  strategy: WindsurfPostAuthEndpointStrategy;
  request: RequestInit;
  timeoutMs: number;
  fetchWithTimeout: (endpoint: string, request: RequestInit, timeoutMs: number) => Promise<Response>;
  onAttempt?: (result: WindsurfPostAuthEndpointAttemptResult) => void;
}): Promise<WindsurfPostAuthEndpointSelectionResult> {
  const attempts: WindsurfPostAuthEndpointAttemptResult[] = [];
  for (const endpoint of args.strategy.endpoints) {
    try {
      const response = await args.fetchWithTimeout(endpoint, args.request, args.timeoutMs);
      const attempt: WindsurfPostAuthEndpointAttemptResult = { ok: true, endpoint, response };
      attempts.push(attempt);
      args.onAttempt?.(attempt);
      return { ok: true, strategy: args.strategy.name, endpoint, response, attempts };
    } catch (error) {
      const attempt: WindsurfPostAuthEndpointAttemptResult = { ok: false, endpoint, error };
      attempts.push(attempt);
      args.onAttempt?.(attempt);
    }
  }
  const lastAttempt = attempts[attempts.length - 1];
  const lastError = lastAttempt && !lastAttempt.ok
    ? lastAttempt.error
    : new Error('windsurf post auth endpoint strategy has no endpoints');
  return {
    ok: false,
    strategy: args.strategy.name,
    attempts,
    error: lastError,
  };
}

export function resolveWindsurfTokenFilePath(args: {
  cfg: WindsurfManagedAuthConfig;
  homeDir: string;
  defaultAuthDir: string;
}): string {
  const raw = typeof args.cfg.tokenFile === 'string' ? args.cfg.tokenFile.trim() : '';
  if (raw) {
    if (raw.startsWith('~/')) {
      return path.join(args.homeDir || '', raw.slice(2));
    }
    return path.resolve(raw);
  }
  const alias = typeof args.cfg.accountAlias === 'string' && args.cfg.accountAlias.trim() ? args.cfg.accountAlias.trim() : 'default';
  return path.join(args.defaultAuthDir, `windsurf-${alias}.json`);
}

export function parsePersistedWindsurfSessionCredential(args: {
  raw: string;
  tokenFilePath: string;
  createError: (message: string, fields: { code: string; status: number; retryable: boolean }) => Error;
}): WindsurfPersistedCredentialParseResult {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(args.raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'malformed', error: args.createError(`[windsurf] malformed token file ${args.tokenFilePath}: expected JSON object`, {
        code: 'WINDSURF_TOKEN_FILE_MALFORMED',
        status: 500,
        retryable: false,
      }) };
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: 'malformed', error: args.createError(`[windsurf] malformed token file ${args.tokenFilePath}: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'WINDSURF_TOKEN_FILE_MALFORMED',
      status: 500,
      retryable: false,
    }) };
  }

  const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  const sessionToken = typeof parsed.sessionToken === 'string' ? parsed.sessionToken.trim() : apiKey;
  const auth1Token = typeof parsed.auth1Token === 'string' ? parsed.auth1Token.trim() : '';
  const accountId = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
  const primaryOrgId = typeof parsed.primaryOrgId === 'string' ? parsed.primaryOrgId.trim() : '';
  if (!keyLikeSessionToken(apiKey || sessionToken)) {
    return { ok: true, credential: null, reason: 'not_session_token' };
  }
  return {
    ok: true,
    credential: {
      apiKey: apiKey || sessionToken,
      sessionToken: sessionToken || apiKey,
      auth1Token,
      ...(accountId ? { accountId } : {}),
      ...(primaryOrgId ? { primaryOrgId } : {}),
    },
    reason: 'session_token',
  };
}

export function parseWindsurfCheckUserLoginMethodPayload(raw: string | Uint8Array): WindsurfLoginMethodPayloadParseResult {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (!text.trim()) return { ok: false, reason: 'empty_body' };
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!parsed) return { ok: false, reason: 'unexpected_shape' };
  const hasUserField = Object.prototype.hasOwnProperty.call(parsed, 'userExists');
  const hasPasswordField = Object.prototype.hasOwnProperty.call(parsed, 'hasPassword');
  if (!hasUserField && !hasPasswordField) return { ok: false, reason: 'unexpected_shape' };
  return {
    ok: true,
    value: {
      userExists: parsed.userExists === false ? false : true,
      hasPassword: !!parsed.hasPassword,
    },
  };
}

export function parseWindsurfPostAuthProtoBuffer(bytes: Uint8Array): WindsurfPostAuthPayloadParseResult & { auth1Token?: string } {
  let index = 0;
  let sessionToken = '';
  let accountId = '';
  let auth1Token = '';
  let primaryOrgId = '';
  while (index < bytes.length) {
    const tag = decodeProtoVarintDetailed(bytes, index);
    if (!tag.ok) return { error: 'WindsurfPostAuth proto tag decode failed' };
    index += tag.consumed;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 2) {
      const len = decodeProtoVarintDetailed(bytes, index);
      if (!len.ok) return { error: 'WindsurfPostAuth proto length decode failed' };
      index += len.consumed;
      const end = index + len.value;
      if (end > bytes.length) return { error: 'WindsurfPostAuth proto length out of range' };
      const payload = Buffer.from(bytes.slice(index, end)).toString('utf8');
      if (fieldNo === 1) sessionToken = payload;
      else if (fieldNo === 3) auth1Token = payload;
      else if (fieldNo === 4) accountId = payload;
      else if (fieldNo === 5) primaryOrgId = payload;
      index = end;
      continue;
    }
    if (wireType === 0) {
      const skipped = decodeProtoVarintDetailed(bytes, index);
      if (!skipped.ok) return { error: 'WindsurfPostAuth proto varint skip failed' };
      index += skipped.consumed;
      continue;
    }
    if (wireType === 1) {
      index += 8;
      continue;
    }
    if (wireType === 5) {
      index += 4;
      continue;
    }
    if (wireType === 3 || wireType === 4) {
      continue;
    }
    return { error: `WindsurfPostAuth proto unrecognized wire type ${wireType}` };
  }
  if (sessionToken || auth1Token || accountId || primaryOrgId) {
    return {
      sessionToken: sessionToken || undefined,
      accountId: accountId || undefined,
      auth1Token: auth1Token || undefined,
      primaryOrgId: primaryOrgId || undefined,
    };
  }
  return { error: 'empty response' };
}

export function parseWindsurfPostAuthPayload(payload: unknown): WindsurfPostAuthPayloadParseResult {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const sessionToken = typeof record.sessionToken === 'string' ? record.sessionToken.trim() : '';
    const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : '';
    const primaryOrgId = typeof record.primaryOrgId === 'string'
      ? record.primaryOrgId.trim()
      : typeof record.primary_org_id === 'string'
        ? String(record.primary_org_id).trim()
        : '';
    if (sessionToken) {
      return {
        sessionToken,
        accountId: accountId || undefined,
        primaryOrgId: primaryOrgId || undefined,
      };
    }
  }
  if (typeof payload === 'string') {
    const protoResult = parseWindsurfPostAuthProtoBuffer(Buffer.from(payload, 'latin1'));
    if (protoResult.sessionToken || protoResult.accountId || protoResult.primaryOrgId) {
      return {
        sessionToken: protoResult.sessionToken,
        accountId: protoResult.accountId,
        primaryOrgId: protoResult.primaryOrgId,
      };
    }
    return { error: protoResult.error || 'empty response' };
  }
  return { error: 'missing sessionToken' };
}

export function extractWindsurfAuthDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const detail = (payload as Record<string, unknown>).detail;
  if (typeof detail === 'string') return detail.trim();
  if (Array.isArray(detail)) {
    return detail
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const record = entry as Record<string, unknown>;
          return typeof record.msg === 'string'
            ? record.msg
            : typeof record.type === 'string'
              ? record.type
              : JSON.stringify(record);
        }
        return '';
      })
      .filter(Boolean)
      .join('; ')
      .trim();
  }
  if (detail && typeof detail === 'object') {
    return JSON.stringify(detail);
  }
  const message = (payload as Record<string, unknown>).message;
  return typeof message === 'string' ? message.trim() : '';
}
