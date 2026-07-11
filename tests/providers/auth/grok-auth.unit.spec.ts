import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  accessTokenIsExpiring,
  buildGrokAuthorizeUrl,
  captureGrokSessionFromAuthFile,
  generateGrokOAuthPkce,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REDIRECT_URI,
  GROK_OAUTH_SCOPE,
  GrokAuthProvider,
  isGrokAuthCandidate,
  writeGrokOAuthTokenFile
} from '../../../src/providers/auth/grok-auth.js';
import { AuthProviderFactory } from '../../../src/providers/core/runtime/transport/auth-provider-factory.js';
import {
  grokFamilyProfile,
  sanitizeGrokResponsesWireBody
} from '../../../src/providers/profile/families/grok-profile.js';
import { getProviderFamilyProfile } from '../../../src/providers/profile/profile-registry.js';

const originalFetch = globalThis.fetch;

function writeTokenFile(filePath: string, entry: Record<string, unknown>, clientId = 'test-client'): void {
  const key = `https://auth.x.ai::${clientId}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ [key]: entry }, null, 2), 'utf8');
}

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('GrokAuthProvider (independent provider)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isGrokAuthCandidate matches providerId/rawType/provider auth path', () => {
    expect(isGrokAuthCandidate({ providerId: 'grok' })).toBe(true);
    expect(isGrokAuthCandidate({ rawType: 'grok' })).toBe(true);
    expect(isGrokAuthCandidate({ tokenFile: '~/.rcc/provider/grok/auth/token-1.json' })).toBe(true);
    expect(isGrokAuthCandidate({ providerId: 'openrouter' })).toBe(false);
  });

  test('captureGrokSessionFromAuthFile reads authorized token file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-'));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, 'auth', 'token-1.json');
    writeTokenFile(tokenFile, {
      key: 'access-token-1',
      refresh_token: 'refresh-1',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'test-client',
      email: 'a@example.com'
    });
    const captured = captureGrokSessionFromAuthFile(tokenFile);
    expect(captured.accessToken).toBe('access-token-1');
    expect(captured.email).toBe('a@example.com');
  });

  test('loads token from provider auth dir and builds headers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-provider-'));
    tempDirs.push(root);
    const tokenFile = path.join(root, 'auth', 'token-1.json');
    writeTokenFile(tokenFile, {
      key: 'access-token-1',
      refresh_token: 'refresh-1',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'test-client',
      user_id: 'u1'
    });

    const provider = new GrokAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'grok',
      providerRoot: root,
      authDir: path.join(root, 'auth'),
      selectionMode: 'priority',
      clientSurface: 'grok-build',
      clientVersion: '0.2.93'
    });
    await provider.initialize();
    expect(provider.getActiveTokenAlias()).toBe('token-1');
    expect(provider.buildHeaders()).toMatchObject({
      Authorization: 'Bearer access-token-1',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-user-id': 'u1'
    });
  });

  test('priority multi-token rotates when current exhausted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-provider-'));
    tempDirs.push(root);
    const t1 = path.join(root, 'auth', 'token-1.json');
    const t2 = path.join(root, 'auth', 'token-2.json');
    writeTokenFile(t1, {
      key: 'token-one',
      refresh_token: 'r1',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'c1'
    }, 'c1');
    writeTokenFile(t2, {
      key: 'token-two',
      refresh_token: 'r2',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'c2'
    }, 'c2');

    const provider = new GrokAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'grok',
      providerRoot: root,
      selectionMode: 'priority',
      entries: [
        { alias: 'token-1', tokenFile: t1 },
        { alias: 'token-2', tokenFile: t2 }
      ]
    });
    await provider.initialize();
    expect(provider.getActiveTokenAlias()).toBe('token-1');
    expect(provider.buildHeaders().Authorization).toBe('Bearer token-one');

    const rotated = await provider.rotateToken('cooldown', 60_000);
    expect(rotated).toBe(true);
    expect(provider.getActiveTokenAlias()).toBe('token-2');
    expect(provider.buildHeaders().Authorization).toBe('Bearer token-two');
  });

  test('AuthProviderFactory creates GrokAuthProvider for providerId=grok', () => {
    const factory = new AuthProviderFactory({
      providerType: 'responses',
      moduleType: 'responses-http-provider',
      config: {
        config: {
          providerId: 'grok',
          auth: {
            type: 'apikey',
            apiKey: '',
            rawType: 'grok',
            selectionMode: 'priority',
            entries: [
              { alias: 'token-1', tokenFile: '~/.rcc/provider/grok/auth/token-1.json' }
            ]
          } as any
        }
      },
      serviceProfile: {
        defaultBaseUrl: 'https://cli-chat-proxy.grok.com/v1',
        defaultEndpoint: '/responses',
        defaultModel: 'grok-build',
        requiredAuth: ['apikey'],
        optionalAuth: []
      }
    });
    expect(factory.createAuthProvider()).toBeInstanceOf(GrokAuthProvider);
  });

  test('family profile injects x-grok-model-override', () => {
    const headers = grokFamilyProfile.applyRequestHeaders?.({
      headers: { Authorization: 'Bearer x', 'X-XAI-Token-Auth': 'xai-grok-cli' },
      request: { model: 'grok-build' },
      runtimeMetadata: { requestId: 'r1', target: { modelId: 'grok-build' } } as any
    });
    expect(headers?.['x-grok-model-override']).toBe('grok-build');
  });

  test('providerId=grok wins over protocol providerFamily=responses', () => {
    const profile = getProviderFamilyProfile({
      providerFamily: 'responses',
      providerId: 'grok',
      providerKey: 'grok.key1.grok-build',
      providerType: 'responses'
    });
    expect(profile?.id).toBe('grok/default');
    expect(profile?.providerFamily).toBe('grok');
    expect(typeof profile?.buildRequestBody).toBe('function');
  });

  test('sanitizeGrokResponsesWireBody maps Codex shapes before dropping unmappable', () => {
    const out = sanitizeGrokResponsesWireBody({
      model: 'grok-build',
      stream: true,
      client_metadata: { session_id: 's' },
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'low', summary: 'detailed' },
      tools: [
        { type: 'function', name: 'shell', parameters: { type: 'object' } },
        { type: 'web_search' },
        { type: 'custom', name: 'apply_patch', parameters: { type: 'object' } }
      ],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', encrypted_content: 'x', summary: [] },
        {
          type: 'reasoning',
          encrypted_content: 'y',
          summary: [{ type: 'summary_text', text: 'think step' }]
        },
        { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: 'patch-body' },
        { type: 'custom_tool_call_output', call_id: 'c2', output: 'y' }
      ]
    });
    expect(out.client_metadata).toBeUndefined();
    expect(out.include).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    expect((out.tools as any[]).map((t) => t.name)).toEqual(['shell', 'apply_patch']);
    const types = (out.input as any[]).map((i) => i.type);
    expect(types).toEqual([
      'message',
      'message', // mapped from reasoning summary
      'function_call',
      'function_call_output',
      'function_call', // mapped from custom_tool_call
      'function_call_output' // mapped from custom_tool_call_output
    ]);
    const mappedPatch = (out.input as any[]).find((i) => i.call_id === 'c2' && i.type === 'function_call');
    expect(mappedPatch.name).toBe('apply_patch');
    expect(mappedPatch.arguments).toContain('patch-body');
  });

  test('refresh persists into provider auth token file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-provider-'));
    tempDirs.push(root);
    const tokenFile = path.join(root, 'auth', 'token-1.json');
    writeTokenFile(tokenFile, {
      key: 'old',
      refresh_token: 'refresh-old',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'test-client'
    });

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600
        })
    })) as any;

    const provider = new GrokAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'grok',
      tokenFile,
      selectionMode: 'priority'
    });
    await provider.initialize();
    expect(provider.buildHeaders().Authorization).toBe('Bearer new-access');
    const persisted = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    expect(persisted['https://auth.x.ai::test-client'].key).toBe('new-access');
  });

  test('accessTokenIsExpiring follows JWT exp skew (opencode-aligned)', () => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    const far = Math.floor(Date.now() / 1000) + 3600;
    expect(accessTokenIsExpiring(makeJwt(soon), 120_000)).toBe(true);
    expect(accessTokenIsExpiring(makeJwt(far), 120_000)).toBe(false);
    expect(accessTokenIsExpiring('opaque-token', 120_000)).toBe(false);
  });

  test('refresh triggers when JWT exp is near even if expires_at is far', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-provider-'));
    tempDirs.push(root);
    const tokenFile = path.join(root, 'auth', 'token-1.json');
    const nearJwt = makeJwt(Math.floor(Date.now() / 1000) + 30);
    writeTokenFile(tokenFile, {
      key: nearJwt,
      refresh_token: 'refresh-old',
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      auth_mode: 'oidc',
      oidc_client_id: 'test-client'
    });

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'refreshed-from-jwt',
          refresh_token: 'refresh-new',
          expires_in: 3600
        })
    })) as any;

    const provider = new GrokAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'grok',
      tokenFile,
      selectionMode: 'priority',
      earlyRefreshMs: 120_000
    });
    await provider.initialize();
    expect(provider.buildHeaders().Authorization).toBe('Bearer refreshed-from-jwt');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test('oauth authorize url uses Grok-CLI client and loopback redirect', async () => {
    const pkce = await generateGrokOAuthPkce();
    const url = new URL(buildGrokAuthorizeUrl(pkce, 'state-1', 'nonce-1'));
    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(GROK_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(GROK_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(GROK_OAUTH_SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('plan')).toBe('generic');
  });

  test('writeGrokOAuthTokenFile persists multi-token auth shape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-grok-oauth-'));
    tempDirs.push(root);
    const tokenFile = path.join(root, 'auth', 'token-oauth.json');
    writeGrokOAuthTokenFile(tokenFile, {
      access_token: 'oauth-access',
      refresh_token: 'oauth-refresh',
      expires_in: 1800
    }, { email: 'u@example.com', user_id: 'u9' });
    const persisted = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const entry = persisted[`https://auth.x.ai::${GROK_OAUTH_CLIENT_ID}`];
    expect(entry.key).toBe('oauth-access');
    expect(entry.refresh_token).toBe('oauth-refresh');
    expect(entry.oidc_client_id).toBe(GROK_OAUTH_CLIENT_ID);
    expect(entry.email).toBe('u@example.com');
  });
});
