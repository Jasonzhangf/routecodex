import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import { TokenFileAuthProvider } from '../../../src/providers/auth/tokenfile-auth.js';

describe('TokenFileAuthProvider initialization', () => {
  test('fails fast when token file payload has no access token', async () => {
    const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-auth-'));
    const tokenFile = path.join(tokenDir, 'ecodev-oauth-2-backup.json');
    fs.writeFileSync(tokenFile, '{}\n', 'utf8');

    const provider = new TokenFileAuthProvider({
      type: 'ecodev-oauth',
      oauthProviderId: 'ecodev',
      tokenFile
    } as any);

    await expect(provider.initialize()).rejects.toThrow(
      `missing required authentication credential: token file missing access token (${tokenFile})`
    );
    expect(provider.getStatus()).toMatchObject({
      isAuthenticated: false,
      isValid: false,
      error: 'missing_access_token_or_api_key'
    });
  });

  test('loads bearer token from token file when payload is usable', async () => {
    const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-auth-'));
    const tokenFile = path.join(tokenDir, 'ecodev-oauth-1-default.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'tokenfile-auth-ok' }) + '\n', 'utf8');

    const provider = new TokenFileAuthProvider({
      type: 'ecodev-oauth',
      oauthProviderId: 'ecodev',
      tokenFile
    } as any);

    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(provider.buildHeaders()).toEqual({
      Authorization: 'Bearer tokenfile-auth-ok'
    });
  });
});
