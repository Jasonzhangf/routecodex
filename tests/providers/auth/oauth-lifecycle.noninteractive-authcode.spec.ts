import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureValidOAuthToken } from '../../../src/providers/auth/oauth-lifecycle.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('ensureValidOAuthToken non-interactive auth-code guard', () => {
  test('iflow auth-code refuses interactive flow when openBrowser=false', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-noninteractive-authcode-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'iflow-oauth-1-default.json');
    writeJson(tokenFile, {
      access_token: 'expired-access',
      expires_at: Date.now() - 60_000
    });

    try {
      await expect(
        ensureValidOAuthToken(
          'iflow',
          {
            type: 'iflow-oauth',
            tokenFile
          } as any,
          {
            openBrowser: false,
            forceReauthorize: true,
            forceReacquireIfRefreshFails: true
          }
        )
      ).rejects.toThrow('interactive authorization requires openBrowser=true');
    } finally {
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
