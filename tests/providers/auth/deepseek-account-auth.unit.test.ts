import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DeepSeekAccountAuthProvider } from '../../../src/providers/auth/deepseek-account-auth.js';

describe('DeepSeekAccountAuthProvider', () => {
  const originalHome = process.env.HOME;
  const originalTokenHelper = process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
  const originalRccTokenHelper = process.env.RCC_DEEPSEEK_TOKEN_HELPER;
  const originalLoginUrl = process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
  const originalRccLoginUrl = process.env.RCC_DEEPSEEK_LOGIN_URL;
  const originalCamoufoxFp = process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT;
  const originalCamoufoxAuto = process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE;
  const originalCamoufoxProvider = process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER;
  const tempDirs: string[] = [];

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (typeof originalTokenHelper === 'string') {
      process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER = originalTokenHelper;
    } else {
      delete process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
    }
    if (typeof originalRccTokenHelper === 'string') {
      process.env.RCC_DEEPSEEK_TOKEN_HELPER = originalRccTokenHelper;
    } else {
      delete process.env.RCC_DEEPSEEK_TOKEN_HELPER;
    }
    if (typeof originalLoginUrl === 'string') {
      process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL = originalLoginUrl;
    } else {
      delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    }
    if (typeof originalRccLoginUrl === 'string') {
      process.env.RCC_DEEPSEEK_LOGIN_URL = originalRccLoginUrl;
    } else {
      delete process.env.RCC_DEEPSEEK_LOGIN_URL;
    }
    if (typeof originalCamoufoxFp === 'string') {
      process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT = originalCamoufoxFp;
    } else {
      delete process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT;
    }
    if (typeof originalCamoufoxAuto === 'string') {
      process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE = originalCamoufoxAuto;
    } else {
      delete process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE;
    }
    if (typeof originalCamoufoxProvider === 'string') {
      process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER = originalCamoufoxProvider;
    } else {
      delete process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER;
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('auto-acquires token via helper command when tokenFile is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-auto-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-3-13823250570.json');
    process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER = `cat >/dev/null; printf '%s\\n' '{"access_token":"auto-token-3"}'`;
    delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await provider.initialize();

    expect(provider.buildHeaders().authorization).toBe('Bearer auto-token-3');
    const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    expect(persisted.access_token).toBe('auto-token-3');
    expect(persisted.account_alias).toBe('3-13823250570');
  });

  it('surfaces readable auth error when helper token acquire fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-helper-fail-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-3-13823250570.json');
    process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER = 'exit 2';
    delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await expect(provider.initialize()).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_INVALID',
      statusCode: 401
    });
    await expect(provider.initialize()).rejects.toThrow('token helper acquire failed');
  });

  it('uses camoufox fingerprint headers and parses deepseek login biz_data.user.token', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-login-fp-home-'));
    tempDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    const authDir = path.join(tmpHome, '.routecodex', 'auth');
    const tokenFile = path.join(authDir, 'deepseek-account-3-13823250570.json');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, 'deepseek-account-3-13823250570.credentials.json'),
      JSON.stringify({ mobile: '13823250570', password: 'welcome4zcam#' }, null, 2) + '\n',
      'utf8'
    );

    const fpDir = path.join(tmpHome, '.routecodex', 'camoufox-fp');
    await fs.mkdir(fpDir, { recursive: true });
    await fs.writeFile(
      path.join(fpDir, 'rc-deepseek.3-13823250570.json'),
      JSON.stringify({
        env: {
          CAMOU_CONFIG_1: JSON.stringify({
            'navigator.userAgent': 'Mozilla/5.0 Camoufox DeepSeek Login Test',
            'navigator.platform': 'Win32'
          })
        }
      }),
      'utf8'
    );

    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT = '1';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE = '0';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER = 'deepseek';
    delete process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
    delete process.env.RCC_DEEPSEEK_TOKEN_HELPER;
    process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/api/v0/users/login';
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          msg: '',
          data: {
            biz_code: 0,
            biz_msg: '',
            biz_data: {
              code: 0,
              msg: '',
              user: { token: 'login-token-3' }
            }
          }
        })
    }));
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;
    try {
      const provider = new DeepSeekAccountAuthProvider({
        type: 'apikey',
        apiKey: '',
        rawType: 'deepseek-account',
        tokenFile
      });

      await provider.initialize();
      expect(provider.buildHeaders().authorization).toBe('Bearer login-token-3');
      expect(fetchMock).toHaveBeenCalled();
      const firstCall = fetchMock.mock.calls[0];
      const requestInit = firstCall?.[1] as RequestInit;
      const headers = (requestInit?.headers || {}) as Record<string, string>;
      expect(headers['User-Agent']).toBe('Mozilla/5.0 Camoufox DeepSeek Login Test');
      expect(headers['x-client-platform']).toBe('windows');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('reads mobile/password from tokenFile and backfills token into same file', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-login-single-file-home-'));
    tempDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    const authDir = path.join(tmpHome, '.routecodex', 'auth');
    const tokenFile = path.join(authDir, 'deepseek-account-3-13823250570.json');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      tokenFile,
      JSON.stringify(
        {
          mobile: '13823250570',
          password: 'welcome4zcam#'
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    delete process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
    delete process.env.RCC_DEEPSEEK_TOKEN_HELPER;
    process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/api/v0/users/login';
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT = '0';
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE = '0';

    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          msg: '',
          data: {
            biz_code: 0,
            biz_msg: '',
            biz_data: {
              code: 0,
              msg: '',
              user: { token: 'single-file-token-3' }
            }
          }
        })
    }));
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;
    try {
      const provider = new DeepSeekAccountAuthProvider({
        type: 'apikey',
        apiKey: '',
        rawType: 'deepseek-account',
        tokenFile
      });

      await provider.initialize();
      expect(provider.buildHeaders().authorization).toBe('Bearer single-file-token-3');

      const persisted = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
      expect(persisted.access_token).toBe('single-file-token-3');
      expect(persisted.mobile).toBe('13823250570');
      expect(persisted.password).toBe('welcome4zcam#');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('loads token from tokenFile', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-2.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify(
        {
          access_token: 'persisted-token',
          account_alias: '2'
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile,
      accountAlias: '2'
    });

    await provider.initialize();

    expect(provider.buildHeaders().authorization).toBe('Bearer persisted-token');
  });

  it('loads token from default alias path when tokenFile is omitted', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-home-'));
    tempDirs.push(tmpHome);
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'deepseek-account-alias-1.json');
    await fs.mkdir(path.dirname(tokenFile), { recursive: true });
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'alias-token' }, null, 2) + '\n', 'utf8');

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      accountAlias: 'alias-1'
    });

    await provider.initialize();

    expect(provider.buildHeaders().authorization).toBe('Bearer alias-token');
  });

  it('refreshCredentials reloads token from tokenFile', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-refresh.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'token-first' }, null, 2) + '\n', 'utf8');

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await provider.initialize();
    expect(provider.buildHeaders().authorization).toBe('Bearer token-first');

    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'token-second' }, null, 2) + '\n', 'utf8');
    await provider.refreshCredentials();

    expect(provider.buildHeaders().authorization).toBe('Bearer token-second');
  });

  it('refreshCredentials force-acquires token when helper command is configured', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-refresh-auto-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-refresh-auto.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'token-old' }, null, 2) + '\n', 'utf8');

    process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER = `cat >/dev/null; printf '%s\\n' '{"access_token":"token-new"}'`;
    delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await provider.initialize();
    expect(provider.buildHeaders().authorization).toBe('Bearer token-old');

    await provider.refreshCredentials();
    expect(provider.buildHeaders().authorization).toBe('Bearer token-new');
  });

  it('validateCredentials hot-reloads token when tokenFile changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-hot-reload.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'token-old' }, null, 2) + '\n', 'utf8');

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await provider.initialize();
    expect(provider.buildHeaders().authorization).toBe('Bearer token-old');

    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'token-new' }, null, 2) + '\n', 'utf8');
    (provider as any).lastTokenCheckAt = 0;
    await provider.validateCredentials();

    expect(provider.buildHeaders().authorization).toBe('Bearer token-new');
  });

  it('fails fast when token file is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-missing.json');
    delete process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
    delete process.env.RCC_DEEPSEEK_TOKEN_HELPER;
    delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await expect(provider.initialize()).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_MISSING'
    });
  });

  it('fails fast when token file has no token', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-empty.json');
    await fs.writeFile(tokenFile, JSON.stringify({ account_alias: '1' }, null, 2) + '\n', 'utf8');
    delete process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER;
    delete process.env.RCC_DEEPSEEK_TOKEN_HELPER;
    delete process.env.ROUTECODEX_DEEPSEEK_LOGIN_URL;
    delete process.env.RCC_DEEPSEEK_LOGIN_URL;

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile
    });

    await expect(provider.initialize()).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_MISSING'
    });
  });

  it('rejects inline apiKey for deepseek-account', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-deepseek-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'deepseek-account-inline.json');
    await fs.writeFile(tokenFile, JSON.stringify({ access_token: 'persisted-token' }, null, 2) + '\n', 'utf8');

    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: 'inline-token-123',
      rawType: 'deepseek-account',
      tokenFile
    });

    await expect(provider.initialize()).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_INVALID'
    });
    await expect(provider.initialize()).rejects.toThrow('unsupported fields: apiKey');
  });

  it('rejects legacy mobile/password/accountFile fields', async () => {
    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account',
      tokenFile: '~/.routecodex/auth/deepseek-account-1.json',
      mobile: '18600000000',
      password: 'secret-password',
      accountFile: '~/.routecodex/auth/deepseek-account-login.json'
    });

    await expect(provider.initialize()).rejects.toMatchObject({
      code: 'DEEPSEEK_AUTH_INVALID'
    });
    await expect(provider.initialize()).rejects.toThrow('mobile, password, accountFile');
  });

  it('throws auth missing before initialize', () => {
    const provider = new DeepSeekAccountAuthProvider({
      type: 'apikey',
      apiKey: '',
      rawType: 'deepseek-account'
    });

    expect(() => provider.buildHeaders()).toThrow();
  });
});
