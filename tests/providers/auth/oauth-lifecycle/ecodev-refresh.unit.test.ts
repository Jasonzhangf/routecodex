import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ensureValidOAuthToken } from '../../../../src/providers/auth/oauth-lifecycle.js';

function createJwtPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'jwtv1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('ecodev OAuth lifecycle refresh', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('refreshes legacy ecodev token files using refresh_token from jwt_token payload', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-lifecycle-'));
    const tokenFile = path.join(tmpDir, 'ecodev-oauth-1-default.json');
    const expSeconds = Math.floor((Date.now() - 60_000) / 1000);
    const jwtToken = createJwtPayload({
      refresh_token: 'jwt-refresh',
      exp: expSeconds
    });
    await fs.writeFile(
      tokenFile,
      `${JSON.stringify(
        {
          access_token: 'old-access',
          refresh_token: '',
          jwt_token: jwtToken,
          token_type: 'Bearer',
          provider: 'ecodev',
          site_id: '1'
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        refresh: 'true',
        jwttoken: jwtToken
      });
      return new Response(JSON.stringify({
        status: true,
        userInfo: {
          accessToken: 'new-access',
          refreshToken: ''
        }
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureValidOAuthToken(
      'ecodev',
      {
        type: 'ecodev-oauth',
        tokenFile
      } as any,
      {
        openBrowser: false,
        forceReauthorize: false,
        forceReacquireIfRefreshFails: false
      }
    );

    const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'jwt-refresh',
      jwt_token: jwtToken,
      expires_at: expSeconds * 1000
    });
  });
});
