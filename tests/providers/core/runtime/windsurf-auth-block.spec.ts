import { describe, expect, test } from '@jest/globals';
import {
  keyLikeSessionToken,
  parseInlineWindsurfAccountDetailed,
  normalizeWindsurfAuthRawType,
  isManagedWindsurfAuthRawType,
  resolveManagedCredentialAuthStrategy,
  buildWindsurfPostAuthEndpointStrategy,
  resolveWindsurfTokenFilePath,
  parsePersistedWindsurfSessionCredential,
  parseWindsurfCheckUserLoginMethodPayload,
  parseWindsurfPostAuthProtoBuffer,
  parseWindsurfPostAuthPayload,
  extractWindsurfAuthDetail,
  selectWindsurfPostAuthEndpoint,
  type WindsurfManagedAuthConfig,
} from '../../../../src/providers/core/runtime/windsurf/auth-block.js';

// --- keyLikeSessionToken ---

describe('auth-block / keyLikeSessionToken', () => {
  test('devin session token returns true', () => {
    expect(keyLikeSessionToken('devin-session-token$abc123')).toBe(true);
  });

  test('devin session token with whitespace returns true', () => {
    expect(keyLikeSessionToken('  devin-session-token$abc  ')).toBe(true);
  });

  test('non-session api key returns false', () => {
    expect(keyLikeSessionToken('sk-abc123')).toBe(false);
  });

  test('empty string returns false', () => {
    expect(keyLikeSessionToken('')).toBe(false);
  });

  test('non-string value returns false', () => {
    expect(keyLikeSessionToken(123)).toBe(false);
    expect(keyLikeSessionToken(null)).toBe(false);
    expect(keyLikeSessionToken(undefined)).toBe(false);
    expect(keyLikeSessionToken({})).toBe(false);
  });
});

// --- parseInlineWindsurfAccountDetailed ---

describe('auth-block / parseInlineWindsurfAccountDetailed', () => {
  test('parses email|password format', () => {
    const result = parseInlineWindsurfAccountDetailed('user@example.com|mypassword');
    expect(result).toEqual({ ok: true, email: 'user@example.com', passwordOrToken: 'mypassword' });
  });

  test('trims whitespace around separator', () => {
    const result = parseInlineWindsurfAccountDetailed('  user@example.com  |  mypassword  ');
    expect(result).toEqual({ ok: true, email: 'user@example.com', passwordOrToken: 'mypassword' });
  });

  test('rejects missing separator', () => {
    const result = parseInlineWindsurfAccountDetailed('justanemail');
    expect(result).toEqual({ ok: false, reason: 'missing_separator' });
  });

  test('rejects separator at start', () => {
    const result = parseInlineWindsurfAccountDetailed('|password');
    expect(result).toEqual({ ok: false, reason: 'missing_separator' });
  });

  test('rejects separator at end', () => {
    const result = parseInlineWindsurfAccountDetailed('email|');
    expect(result).toEqual({ ok: false, reason: 'missing_separator' });
  });

  test('rejects non-string input', () => {
    expect(parseInlineWindsurfAccountDetailed(123)).toEqual({ ok: false, reason: 'not_string' });
    expect(parseInlineWindsurfAccountDetailed(null)).toEqual({ ok: false, reason: 'not_string' });
    expect(parseInlineWindsurfAccountDetailed(undefined)).toEqual({ ok: false, reason: 'not_string' });
  });
});

// --- normalizeWindsurfAuthRawType ---

describe('auth-block / normalizeWindsurfAuthRawType', () => {
  test('lowercases and trims', () => {
    expect(normalizeWindsurfAuthRawType('  Windsurf-Account  ')).toBe('windsurf-account');
  });

  test('returns empty string for non-string input', () => {
    expect(normalizeWindsurfAuthRawType(null)).toBe('');
    expect(normalizeWindsurfAuthRawType(undefined)).toBe('');
    expect(normalizeWindsurfAuthRawType(123)).toBe('');
  });

  test('preserves already normalized type', () => {
    expect(normalizeWindsurfAuthRawType('windsurf-devin-token')).toBe('windsurf-devin-token');
  });
});

// --- isManagedWindsurfAuthRawType ---

describe('auth-block / isManagedWindsurfAuthRawType', () => {
  test('windsurf-account is managed', () => {
    expect(isManagedWindsurfAuthRawType('windsurf-account')).toBe(true);
  });

  test('windsurf-devin-token is managed', () => {
    expect(isManagedWindsurfAuthRawType('windsurf-devin-token')).toBe(true);
  });

  test('other types are not managed', () => {
    expect(isManagedWindsurfAuthRawType('apikey')).toBe(false);
    expect(isManagedWindsurfAuthRawType('')).toBe(false);
  });
});

// --- resolveManagedCredentialAuthStrategy ---

describe('auth-block / resolveManagedCredentialAuthStrategy', () => {
  const makeConfig = (overrides: Partial<WindsurfManagedAuthConfig> = {}): WindsurfManagedAuthConfig => ({
    apiKey: '',
    ...overrides,
  });

  test('password login available when email and password present', () => {
    const cfg = makeConfig({ mobile: 'user@example.com', password: 'secret' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: true });
  });

  test('password login available with account field', () => {
    const cfg = makeConfig({ account: 'user123', password: 'secret' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: true });
  });

  test('password login available with username field', () => {
    const cfg = makeConfig({ username: 'user123', password: 'secret' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: true });
  });

  test('password login available from inline apiKey', () => {
    const cfg = makeConfig({ apiKey: 'user@example.com|mypassword' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: true });
  });

  test('password login unavailable when email missing', () => {
    const cfg = makeConfig({ password: 'secret' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: false });
  });

  test('password login unavailable when password missing', () => {
    const cfg = makeConfig({ mobile: 'user@example.com' });
    expect(resolveManagedCredentialAuthStrategy(cfg)).toEqual({ passwordLoginAvailable: false });
  });

  test('password login unavailable when both missing', () => {
    expect(resolveManagedCredentialAuthStrategy(makeConfig())).toEqual({ passwordLoginAvailable: false });
  });
});

// --- buildWindsurfPostAuthEndpointStrategy ---

describe('auth-block / buildWindsurfPostAuthEndpointStrategy', () => {
  test('creates ordered endpoint list', () => {
    const strategy = buildWindsurfPostAuthEndpointStrategy(
      'https://app-backend/channel',
      'https://self-serve/channel',
    );
    expect(strategy.name).toBe('app_backend_then_self_serve');
    expect(strategy.endpoints).toEqual([
      'https://app-backend/channel',
      'https://self-serve/channel',
    ]);
  });
});

// --- resolveWindsurfTokenFilePath ---

describe('auth-block / resolveWindsurfTokenFilePath', () => {
  const defaults = { homeDir: '/home/user', defaultAuthDir: '/home/user/.rcc/auth' };

  test('uses explicit tokenFile with ~ expansion', () => {
    const path = resolveWindsurfTokenFilePath({
      cfg: { tokenFile: '~/tokens/ws.json' },
      ...defaults,
    });
    expect(path).toBe('/home/user/tokens/ws.json');
  });

  test('resolves absolute tokenFile as-is', () => {
    const path = resolveWindsurfTokenFilePath({
      cfg: { tokenFile: '/etc/windsurf/token.json' },
      ...defaults,
    });
    expect(path).toBe('/etc/windsurf/token.json');
  });

  test('falls back to default dir with alias', () => {
    const path = resolveWindsurfTokenFilePath({
      cfg: { accountAlias: 'ws-pro-1' },
      ...defaults,
    });
    expect(path).toBe('/home/user/.rcc/auth/windsurf-ws-pro-1.json');
  });

  test('falls back to default dir with default alias', () => {
    const path = resolveWindsurfTokenFilePath({
      cfg: {},
      ...defaults,
    });
    expect(path).toBe('/home/user/.rcc/auth/windsurf-default.json');
  });
});

// --- parsePersistedWindsurfSessionCredential ---

describe('auth-block / parsePersistedWindsurfSessionCredential', () => {
  const createError = (msg: string, _fields: unknown) => new Error(msg);

  test('parses valid session token JSON', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: JSON.stringify({ apiKey: 'devin-session-token$abc', sessionToken: 'devin-session-token$abc', auth1Token: 'auth1xyz' }),
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result).toEqual({
      ok: true,
      credential: {
        apiKey: 'devin-session-token$abc',
        sessionToken: 'devin-session-token$abc',
        auth1Token: 'auth1xyz',
      },
      reason: 'session_token',
    });
  });

  test('parses minimal session token (apiKey only)', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: JSON.stringify({ apiKey: 'devin-session-token$minimal' }),
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result).toEqual({
      ok: true,
      credential: {
        apiKey: 'devin-session-token$minimal',
        sessionToken: 'devin-session-token$minimal',
        auth1Token: '',
      },
      reason: 'session_token',
    });
  });

  test('parses with accountId and primaryOrgId', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: JSON.stringify({
        apiKey: 'devin-session-token$abc',
        accountId: 'acc_123',
        primaryOrgId: 'org_456',
      }),
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result.ok && result.credential.accountId).toBe('acc_123');
    expect(result.ok && result.credential.primaryOrgId).toBe('org_456');
  });

  test('non-session apiKey returns not_session_token', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: JSON.stringify({ apiKey: 'sk-regular' }),
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result).toEqual({
      ok: true,
      credential: null,
      reason: 'not_session_token',
    });
  });

  test('malformed JSON returns malformed error', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: 'not-json',
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  test('non-object JSON returns malformed', () => {
    const result = parsePersistedWindsurfSessionCredential({
      raw: '"justastring"',
      tokenFilePath: '/tmp/token.json',
      createError,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });
});

// --- parseWindsurfCheckUserLoginMethodPayload ---

describe('auth-block / parseWindsurfCheckUserLoginMethodPayload', () => {
  test('parses valid payload with both fields', () => {
    const result = parseWindsurfCheckUserLoginMethodPayload(
      JSON.stringify({ userExists: true, hasPassword: true }),
    );
    expect(result).toEqual({ ok: true, value: { userExists: true, hasPassword: true } });
  });

  test('parses userExists: false', () => {
    const result = parseWindsurfCheckUserLoginMethodPayload(
      JSON.stringify({ userExists: false, hasPassword: false }),
    );
    expect(result).toEqual({ ok: true, value: { userExists: false, hasPassword: false } });
  });

  test('rejects empty body', () => {
    expect(parseWindsurfCheckUserLoginMethodPayload('')).toEqual({ ok: false, reason: 'empty_body' });
    expect(parseWindsurfCheckUserLoginMethodPayload('   ')).toEqual({ ok: false, reason: 'empty_body' });
  });

  test('rejects invalid JSON', () => {
    expect(parseWindsurfCheckUserLoginMethodPayload('{bad')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  test('rejects missing expected fields', () => {
    expect(parseWindsurfCheckUserLoginMethodPayload('{"other": true}')).toEqual({ ok: false, reason: 'unexpected_shape' });
  });

  test('accepts Uint8Array input', () => {
    const bytes = Buffer.from(JSON.stringify({ userExists: true, hasPassword: false }));
    const result = parseWindsurfCheckUserLoginMethodPayload(bytes);
    expect(result).toEqual({ ok: true, value: { userExists: true, hasPassword: false } });
  });
});

// --- parseWindsurfPostAuthProtoBuffer ---

describe('auth-block / parseWindsurfPostAuthProtoBuffer', () => {
  function buildProtoField(fieldNo: number, content: string): Uint8Array {
    const payload = Buffer.from(content, 'utf8');
    const tag = (fieldNo << 3) | 2; // wire type 2 (length-delimited)
    const header: number[] = [];
    // encode tag as varint
    let t = tag;
    while (t >= 128) { header.push((t & 0x7f) | 0x80); t >>>= 7; }
    header.push(t);
    // encode length as varint
    let len = payload.length;
    const lenBytes: number[] = [];
    while (len >= 128) { lenBytes.push((len & 0x7f) | 0x80); len >>>= 7; }
    lenBytes.push(len);
    return Buffer.concat([Buffer.from(header), Buffer.from(lenBytes), payload]);
  }

  test('parses all fields from protobuf', () => {
    const bytes = Buffer.concat([
      buildProtoField(1, 'token_abc'),
      buildProtoField(3, 'auth1_val'),
      buildProtoField(4, 'acc_123'),
      buildProtoField(5, 'org_456'),
    ]);
    const result = parseWindsurfPostAuthProtoBuffer(bytes);
    expect(result).toEqual({
      sessionToken: 'token_abc',
      auth1Token: 'auth1_val',
      accountId: 'acc_123',
      primaryOrgId: 'org_456',
    });
  });

  test('returns empty response for empty input', () => {
    const result = parseWindsurfPostAuthProtoBuffer(Buffer.alloc(0));
    expect(result).toEqual({ error: 'empty response' });
  });

  test('handles varint overflow gracefully', () => {
    // A tag that looks like a length-delimited field but has huge varint
    const bytes = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x00]);
    const result = parseWindsurfPostAuthProtoBuffer(bytes);
    expect(result.error).toMatch(/proto tag decode/);
  });
});

// --- parseWindsurfPostAuthPayload ---

describe('auth-block / parseWindsurfPostAuthPayload', () => {
  test('parses JSON object with sessionToken', () => {
    const result = parseWindsurfPostAuthPayload({ sessionToken: 'tok_123', accountId: 'acc_456' });
    expect(result).toEqual({ sessionToken: 'tok_123', accountId: 'acc_456', primaryOrgId: undefined });
  });

  test('parses primary_org_id snake_case variant', () => {
    const result = parseWindsurfPostAuthPayload({ sessionToken: 'tok_123', primary_org_id: 'org_789' });
    expect(result.primaryOrgId).toBe('org_789');
  });

  test('falls back to proto buffer for string payload', () => {
    // This string doesn't look like a valid proto; should return error
    const result = parseWindsurfPostAuthPayload('not-a-protobuf');
    expect(result.error).toBeTruthy();
  });

  test('returns error for missing session token', () => {
    const result = parseWindsurfPostAuthPayload({ other: 'data' });
    expect(result.error).toBe('missing sessionToken');
  });

  test('returns error for non-object non-string', () => {
    expect(parseWindsurfPostAuthPayload(null).error).toBe('missing sessionToken');
    expect(parseWindsurfPostAuthPayload(123).error).toBe('missing sessionToken');
  });
});

// --- extractWindsurfAuthDetail ---

describe('auth-block / extractWindsurfAuthDetail', () => {
  test('extracts string detail field', () => {
    expect(extractWindsurfAuthDetail({ detail: 'auth failed' })).toBe('auth failed');
  });

  test('extracts message from array detail entries', () => {
    const result = extractWindsurfAuthDetail({
      detail: [{ msg: 'rate limit' }, { msg: 'try again' }],
    });
    expect(result).toBe('rate limit; try again');
  });

  test('falls back to type field when msg absent', () => {
    const result = extractWindsurfAuthDetail({
      detail: [{ type: 'quota_exceeded' }],
    });
    expect(result).toBe('quota_exceeded');
  });

  test('extracts message field as fallback', () => {
    expect(extractWindsurfAuthDetail({ message: 'something went wrong' })).toBe('something went wrong');
  });

  test('returns empty for null/undefined/non-object', () => {
    expect(extractWindsurfAuthDetail(null)).toBe('');
    expect(extractWindsurfAuthDetail(undefined)).toBe('');
    expect(extractWindsurfAuthDetail('string')).toBe('');
  });

  test('handles nested detail object', () => {
    const result = extractWindsurfAuthDetail({ detail: { nested: true, code: 'E001' } });
    expect(result).toBe('{"nested":true,"code":"E001"}');
  });
});

// --- selectWindsurfPostAuthEndpoint ---

describe('auth-block / selectWindsurfPostAuthEndpoint', () => {
  test('returns first successful endpoint', async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    const fetchSpy = jest.fn<(endpoint: string, _req: RequestInit, _timeout: number) => Promise<Response>>();
    fetchSpy.mockResolvedValueOnce(mockResponse);

    const result = await selectWindsurfPostAuthEndpoint({
      strategy: buildWindsurfPostAuthEndpointStrategy('https://primary/endpoint', 'https://fallback/endpoint'),
      request: {} as RequestInit,
      timeoutMs: 5000,
      fetchWithTimeout: fetchSpy,
    });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; endpoint: string }).endpoint).toBe('https://primary/endpoint');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('falls through to second endpoint when first fails', async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    const fetchSpy = jest.fn<(endpoint: string, _req: RequestInit, _timeout: number) => Promise<Response>>();
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    fetchSpy.mockResolvedValueOnce(mockResponse);

    const result = await selectWindsurfPostAuthEndpoint({
      strategy: buildWindsurfPostAuthEndpointStrategy('https://primary/endpoint', 'https://fallback/endpoint'),
      request: {} as RequestInit,
      timeoutMs: 5000,
      fetchWithTimeout: fetchSpy,
    });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; endpoint: string }).endpoint).toBe('https://fallback/endpoint');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('returns failure when all endpoints fail', async () => {
    const fetchSpy = jest.fn<(endpoint: string, _req: RequestInit, _timeout: number) => Promise<Response>>();
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const result = await selectWindsurfPostAuthEndpoint({
      strategy: buildWindsurfPostAuthEndpointStrategy('https://primary/endpoint', 'https://fallback/endpoint'),
      request: {} as RequestInit,
      timeoutMs: 5000,
      fetchWithTimeout: fetchSpy,
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; attempts: unknown[] }).attempts).toHaveLength(2);
  });

  test('calls onAttempt callback for each attempt', async () => {
    const fetchSpy = jest.fn<(endpoint: string, _req: RequestInit, _timeout: number) => Promise<Response>>();
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
    const onAttempt = jest.fn();

    await selectWindsurfPostAuthEndpoint({
      strategy: buildWindsurfPostAuthEndpointStrategy('https://ep1', 'https://ep2'),
      request: {} as RequestInit,
      timeoutMs: 5000,
      fetchWithTimeout: fetchSpy,
      onAttempt,
    });

    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ ok: true, endpoint: 'https://ep1' }));
  });
});
