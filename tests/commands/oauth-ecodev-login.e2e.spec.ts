import { afterEach, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOauthCommand } from '../../src/commands/oauth.js';

function createJwtPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'jwtv1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== 'number') {
    throw new Error('failed to bind test server');
  }
  return address.port;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function startEcoDevMockServer(): Promise<{
  server: http.Server;
  baseUrl: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
}> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const jwtToken = createJwtPayload({
    refresh_token: 'jwt-refresh-e2e',
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url || '/', headers: req.headers });
    if ((req.url || '').startsWith('/temptoken/check')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(jwtToken);
      return;
    }
    if ((req.url || '').startsWith('/jwToken/check')) {
      const refresh = String(req.headers.refresh || '').toLowerCase() === 'true';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: true,
        userInfo: {
          accessToken: refresh ? 'access-refreshed-e2e' : 'access-login-e2e',
          refreshToken: ''
        }
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return listen(server).then((port) => ({
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests
  }));
}

async function waitForLoginUrl(logs: string[]): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hit = logs.find((line) => line.includes('/console/DevEcoIDE/apply?'));
    if (hit) {
      const match = hit.match(/https?:\/\/\S+/);
      if (match) {
        return match[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`login URL was not printed; logs=${logs.join('\n')}`);
}

describe('oauth ecodev-login E2E', () => {
  jest.setTimeout(15000);

  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.env = { ...originalEnv };
    process.exitCode = undefined;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    jest.restoreAllMocks();
  });

  it('starts login, waits for callback, writes token, and verifies refresh', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-login-e2e-'));
    tempDirs.push(authDir);
    const tokenFile = path.join(authDir, 'ecodev-oauth-2-backup.json');
    const callbackPort = await freePort();
    const upstream = await startEcoDevMockServer();
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });

    process.env.ROUTECODEX_ECODEV_OAUTH_PORTS = String(callbackPort);
    process.env.RCC_ECODEV_OAUTH_PORTS = String(callbackPort);

    try {
      const cmd = createOauthCommand();
      const run = cmd.parseAsync([
        'node',
        'oauth',
        'ecodev-login',
        'backup',
        '--no-browser',
        '--verify-refresh',
        '--token-file',
        tokenFile,
        '--token-url',
        `${upstream.baseUrl}/temptoken/check`,
        '--user-info-url',
        `${upstream.baseUrl}/jwToken/check`
      ], { from: 'node' });

      const loginUrl = await waitForLoginUrl(logs);
      const parsed = new URL(loginUrl);
      expect(parsed.searchParams.get('port')).toBe(String(callbackPort));
      const code = parsed.searchParams.get('code');
      expect(code).toBeTruthy();

      const callback = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=${encodeURIComponent(code || '')}&tempToken=temp-e2e&siteId=1`,
        { redirect: 'manual' }
      );
      expect(callback.status).toBe(302);

      await run;

      const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
      expect(saved).toMatchObject({
        access_token: 'access-refreshed-e2e',
        refresh_token: 'jwt-refresh-e2e',
        provider: 'ecodev',
        site_id: '1'
      });
      expect(upstream.requests.map((request) => request.url)).toEqual([
        expect.stringContaining('/temptoken/check'),
        expect.stringContaining('/jwToken/check'),
        expect.stringContaining('/jwToken/check')
      ]);
      expect(String(upstream.requests[1]?.headers.refresh)).toBe('false');
      expect(String(upstream.requests[2]?.headers.refresh)).toBe('true');
      expect(logs.join('\n')).toContain('refresh verification succeeded');
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });

  it('force-refreshes an existing EcoDev token without browser login', async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-ecodev-refresh-e2e-'));
    tempDirs.push(authDir);
    const tokenFile = path.join(authDir, 'ecodev-oauth-2-backup.json');
    const jwtToken = createJwtPayload({
      refresh_token: 'jwt-refresh-e2e',
      exp: Math.floor(Date.now() / 1000) + 3600
    });
    await fs.writeFile(
      tokenFile,
      `${JSON.stringify({
        access_token: 'access-old-e2e',
        refresh_token: 'jwt-refresh-e2e',
        jwt_token: jwtToken,
        token_type: 'Bearer',
        provider: 'ecodev',
        site_id: '1'
      }, null, 2)}\n`,
      'utf8'
    );
    const upstream = await startEcoDevMockServer();
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    process.env.RCC_AUTH_DIR = authDir;

    try {
      const cmd = createOauthCommand();
      await cmd.parseAsync([
        'node',
        'oauth',
        'ecodev-refresh',
        'backup',
        '--token-url',
        `${upstream.baseUrl}/temptoken/check`,
        '--user-info-url',
        `${upstream.baseUrl}/jwToken/check`
      ], { from: 'node' });

      const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
      expect(saved).toMatchObject({
        access_token: 'access-refreshed-e2e',
        refresh_token: 'jwt-refresh-e2e',
        provider: 'ecodev',
        site_id: '1'
      });
      expect(upstream.requests.map((request) => request.url)).toEqual([
        expect.stringContaining('/jwToken/check')
      ]);
      expect(String(upstream.requests[0]?.headers.refresh)).toBe('true');
      expect(logs.join('\n')).toContain('refresh succeeded');
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });
});
