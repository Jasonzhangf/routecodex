import fs from 'fs/promises';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  BaseOAuthFlowStrategy,
  OAuthFlowType,
  type OAuthFlowConfig,
  type OAuthFlowStrategyFactory
} from '../config/oauth-flows.js';

const DEVECO_BASE_URL = 'https://cn.devecostudio.huawei.com';
const DEVECO_SUCCESS_REDIRECT_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginSuccess`;
const DEVECO_FAILED_REDIRECT_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginFailed`;
const DEVECO_APP_ID = '1008';
const CALLBACK_PATH = '/callback';
const DEFAULT_CALLBACK_PORTS = [10101, 34567, 34568, 34569, 34570];

type EcoDevTokenPayload = UnknownObject & {
  access_token: string;
  refresh_token: string;
  jwt_token: string;
  token_type: 'Bearer';
  provider: 'ecodev';
  site_id: '1';
  expires_at?: number;
};

function firstParam(params: URLSearchParams, key: string): string {
  return params.get(key)?.trim() ?? '';
}

function readParams(callbackPath: string, body: string): URLSearchParams {
  const url = new URL(callbackPath, 'http://127.0.0.1');
  const params = new URLSearchParams(url.search);
  if (body.trim()) {
    const bodyParams = new URLSearchParams(body);
    for (const [key, value] of bodyParams.entries()) {
      params.set(key, value);
    }
  }
  return params;
}

export function parseEcoDevCallbackParams(
  callbackPath: string,
  body: string,
  expectedCode: string
): { tempToken: string; siteId: '1' } {
  const params = readParams(callbackPath, body);
  const code = firstParam(params, 'code');
  const tempToken = firstParam(params, 'tempToken');
  const siteId = firstParam(params, 'siteId');
  const quit = firstParam(params, 'quit');

  if (!code || code !== expectedCode) {
    throw new Error('EcoDev OAuth callback code mismatch or missing');
  }
  if (quit === 'true' || quit === 'access_denied') {
    throw new Error(quit === 'access_denied' ? 'EcoDev OAuth access denied by user' : 'EcoDev OAuth cancelled by user');
  }
  if (!tempToken) {
    throw new Error('Missing tempToken');
  }
  if (!siteId) {
    throw new Error('Missing siteId');
  }
  if (siteId !== '1') {
    throw new Error('Unsupported region: only siteId=1 is supported');
  }
  return {
    tempToken,
    siteId: '1'
  };
}

function assertJwtFormat(jwtToken: string): void {
  if (jwtToken.split('.').length !== 3) {
    throw new Error('Invalid JWT format');
  }
}

function parseJwtPayload(jwtToken: string): Record<string, unknown> {
  assertJwtFormat(jwtToken);
  const payload = jwtToken.split('.')[1] ?? '';
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid EcoDev JWT payload');
  }
  return parsed as Record<string, unknown>;
}

function readJwtString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readJwtExpiryMillis(payload: Record<string, unknown>): number | undefined {
  const value = payload.exp;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
    }
  }
  return undefined;
}

function buildLoginUrl(port: number, code: string): string {
  const url = new URL('/console/DevEcoIDE/apply', DEVECO_BASE_URL);
  url.searchParams.set('port', String(port));
  url.searchParams.set('appid', DEVECO_APP_ID);
  url.searchParams.set('code', code);
  return url.toString();
}

function resolveCallbackTimeoutMs(): number {
  const raw = String(process.env.ROUTECODEX_ECODEV_OAUTH_TIMEOUT_MS || process.env.RCC_ECODEV_OAUTH_TIMEOUT_MS || '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

function resolveCallbackPorts(): number[] {
  const raw = String(process.env.ROUTECODEX_ECODEV_OAUTH_PORTS || process.env.RCC_ECODEV_OAUTH_PORTS || '').trim();
  if (!raw) {
    return DEFAULT_CALLBACK_PORTS;
  }
  const ports = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 65535);
  return ports.length ? ports : DEFAULT_CALLBACK_PORTS;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class EcoDevOAuthFlowStrategy extends BaseOAuthFlowStrategy {
  private readonly tokenFile: string;

  constructor(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string) {
    super(config, httpClient);
    this.tokenFile = tokenFile || path.join(process.env.HOME || '', '.rcc', 'auth', 'ecodev-oauth-1-default.json');
  }

  async authenticate(options: { openBrowser?: boolean; forceReauthorize?: boolean } = {}): Promise<UnknownObject> {
    const code = randomUUID().replace(/-/g, '');
    const callback = await this.startCallbackServer(code);
    try {
      const loginUrl = buildLoginUrl(callback.port, code);
      await this.activateEcoDevLoginUrl(loginUrl, options);
      const result = await callback.result;
      return await this.exchangeTempTokenForToken(result.tempToken);
    } finally {
      callback.close();
    }
  }

  async exchangeTempTokenForToken(tempToken: string): Promise<EcoDevTokenPayload> {
    const actualTempToken = tempToken.split('&')[0]?.trim() ?? '';
    if (!actualTempToken) {
      throw new Error('Missing tempToken');
    }

    const tokenUrl = new URL(this.config.endpoints.tokenUrl);
    tokenUrl.searchParams.set('tempToken', actualTempToken);
    tokenUrl.searchParams.set('site', 'CN');
    tokenUrl.searchParams.set('version', '1.0.0');
    tokenUrl.searchParams.set('appid', DEVECO_APP_ID);

    const jwtResponse = await this.httpClient(tokenUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'text/plain, application/json'
      }
    });
    if (!jwtResponse.ok) {
      throw new Error(`Failed to get EcoDev JWT: ${jwtResponse.status}`);
    }
    const jwtToken = (await jwtResponse.text()).trim();
    const jwtPayload = parseJwtPayload(jwtToken);
    return await this.checkJwtToken(jwtToken, {
      refresh: false,
      refreshToken: readJwtString(jwtPayload, 'refresh_token'),
      expiresAt: readJwtExpiryMillis(jwtPayload)
    });
  }

  async refreshToken(refreshToken: string): Promise<UnknownObject> {
    const token = await this.loadToken();
    const jwtToken = typeof token?.jwt_token === 'string' ? token.jwt_token.trim() : '';
    if (!jwtToken) {
      throw new Error('EcoDev OAuth refresh requires existing jwt_token');
    }
    const jwtPayload = parseJwtPayload(jwtToken);
    const storedRefreshToken = readJwtString(jwtPayload, 'refresh_token');
    const expectedRefreshToken = refreshToken.trim();
    if (!expectedRefreshToken) {
      throw new Error('EcoDev OAuth refresh requires refresh_token');
    }
    if (!storedRefreshToken || storedRefreshToken !== expectedRefreshToken) {
      throw new Error('EcoDev OAuth refresh token does not match jwt_token payload');
    }
    return await this.checkJwtToken(jwtToken, {
      refresh: true,
      refreshToken: storedRefreshToken,
      expiresAt: readJwtExpiryMillis(jwtPayload)
    });
  }

  private async checkJwtToken(
    jwtToken: string,
    options: { refresh: boolean; refreshToken: string; expiresAt?: number }
  ): Promise<EcoDevTokenPayload> {
    const userInfoUrl = this.config.endpoints.userInfoUrl;
    if (!userInfoUrl) {
      throw new Error('EcoDev OAuth userInfoUrl is required');
    }
    const infoResponse = await this.httpClient(userInfoUrl, {
      method: 'GET',
      headers: {
        refresh: options.refresh ? 'true' : 'false',
        jwtToken
      }
    });
    if (!infoResponse.ok) {
      throw new Error(`Failed to check EcoDev JWT: ${infoResponse.status}`);
    }
    const infoData = await infoResponse.json() as Record<string, unknown>;
    const userInfo = infoData.userInfo;
    if (infoData.status !== true || !userInfo || typeof userInfo !== 'object') {
      throw new Error('Invalid EcoDev JWT userInfo');
    }
    const userInfoRecord = userInfo as Record<string, unknown>;
    const accessToken = typeof userInfoRecord.accessToken === 'string' ? userInfoRecord.accessToken.trim() : '';
    if (!accessToken) {
      throw new Error('EcoDev JWT userInfo missing accessToken');
    }
    return {
      access_token: accessToken,
      refresh_token: options.refreshToken,
      jwt_token: jwtToken,
      token_type: 'Bearer',
      provider: 'ecodev',
      site_id: '1',
      ...(options.expiresAt ? { expires_at: options.expiresAt } : {})
    };
  }

  validateToken(token: UnknownObject): boolean {
    return !!(
      token
      && typeof token === 'object'
      && typeof (token as Record<string, unknown>).access_token === 'string'
      && String((token as Record<string, unknown>).access_token).trim()
    );
  }

  getAuthHeader(token: UnknownObject): string {
    if (!this.validateToken(token)) {
      throw new Error('EcoDev OAuth token missing access_token');
    }
    return `Bearer ${String((token as Record<string, unknown>).access_token).trim()}`;
  }

  async saveToken(token: UnknownObject): Promise<void> {
    if (!this.validateToken(token)) {
      throw new Error('EcoDev OAuth token missing access_token');
    }
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
    await fs.writeFile(this.tokenFile, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async loadToken(): Promise<UnknownObject | null> {
    try {
      return JSON.parse(await fs.readFile(this.tokenFile, 'utf8')) as UnknownObject;
    } catch {
      return null;
    }
  }

  private async startCallbackServer(expectedCode: string): Promise<{
    port: number;
    result: Promise<{ tempToken: string; siteId: '1' }>;
    close: () => void;
  }> {
    const timeoutMs = resolveCallbackTimeoutMs();
    for (const port of resolveCallbackPorts()) {
      try {
        return await this.startCallbackServerOnPort(port, expectedCode, timeoutMs);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'EADDRINUSE') {
          continue;
        }
        throw error;
      }
    }
    throw new Error('All EcoDev OAuth callback ports are in use');
  }

  private async activateEcoDevLoginUrl(
    loginUrl: string,
    options: { openBrowser?: boolean }
  ): Promise<void> {
    console.log('Opening browser for EcoDev authentication...');
    console.log(`URL: ${loginUrl}`);
    if (options.openBrowser === false) {
      return;
    }
    await openSystemBrowser(loginUrl);
  }

  private async startCallbackServerOnPort(port: number, expectedCode: string, timeoutMs: number): Promise<{
    port: number;
    result: Promise<{ tempToken: string; siteId: '1' }>;
    close: () => void;
  }> {
    let server: http.Server | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let settleResult: ((value: { tempToken: string; siteId: '1' }) => void) | null = null;
    let rejectResult: ((reason?: unknown) => void) | null = null;
    const result = new Promise<{ tempToken: string; siteId: '1' }>((resolve, reject) => {
      settleResult = resolve;
      rejectResult = reject;
    });

    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = req.url || '/';
        const parsed = new URL(requestUrl, 'http://127.0.0.1');
        if (parsed.pathname !== CALLBACK_PATH) {
          res.writeHead(204);
          res.end();
          return;
        }
        const body = await readRequestBody(req);
        const parsedParams = parseEcoDevCallbackParams(requestUrl, body, expectedCode);
        res.writeHead(302, { Location: DEVECO_SUCCESS_REDIRECT_URL });
        res.end();
        settleResult?.(parsedParams);
      } catch (error) {
        res.writeHead(302, { Location: DEVECO_FAILED_REDIRECT_URL });
        res.end();
        rejectResult?.(error);
      }
    });

    const boundPort = await new Promise<number>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(port, '127.0.0.1', () => {
        const address = server?.address() as AddressInfo | null;
        resolve(address?.port ?? port);
      });
    });

    timeout = setTimeout(() => {
      rejectResult?.(new Error(`EcoDev OAuth callback timeout after ${Math.floor(timeoutMs / 1000)} seconds`));
      server?.close();
    }, timeoutMs);

    result.finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
      server?.close();
    }).catch(() => undefined);

    return {
      port: boundPort,
      result,
      close: () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        server?.close();
      }
    };
  }
}

async function openSystemBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32'
      ? 'rundll32'
      : 'xdg-open';
  const args = platform === 'win32'
    ? ['url.dll,FileProtocolHandler', url]
    : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Failed to open EcoDev OAuth URL with ${command} (exit=${code ?? 'unknown'})`));
    });
    child.unref();
  });
}

export class EcoDevOAuthFlowStrategyFactory implements OAuthFlowStrategyFactory {
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    return new EcoDevOAuthFlowStrategy(config, httpClient, tokenFile);
  }

  getFlowType(): OAuthFlowType {
    return OAuthFlowType.AUTHORIZATION_CODE;
  }
}
