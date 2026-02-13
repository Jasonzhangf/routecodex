import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEEPSEEK_ERROR_CODES,
  type DeepSeekErrorCode
} from '../core/contracts/deepseek-provider-contract.js';
import { ensureCamoufoxFingerprintForToken, getCamoufoxProfileDir } from '../core/config/camoufox-launcher.js';

type DeepSeekAuthError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
};

type DeepSeekCredential = {
  mobile: string;
  password: string;
};

type TokenFileSnapshot = {
  token?: string;
  credential: DeepSeekCredential | null;
  sourceObject: Record<string, unknown> | null;
};

export type EnsureDeepSeekTokenReason = 'initialize' | 'validate' | 'refresh' | 'daemon' | 'manual';

export type EnsureDeepSeekAccountTokenOptions = {
  tokenFilePath: string;
  accountAlias?: string;
  reason?: EnsureDeepSeekTokenReason;
  forceAcquire?: boolean;
};

export type EnsureDeepSeekAccountTokenResult = {
  token: string;
  tokenFilePath: string;
  accountAlias: string;
  acquired: boolean;
  source: 'token-file' | 'helper-command' | 'http-login';
};

const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.routecodex', 'auth');
const DEFAULT_DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/api/v0/users/login';
const DEFAULT_DEEPSEEK_USER_AGENT = 'DeepSeek/1.0.13 Android/35';
const DEFAULT_CAMOUFOX_PROVIDER = 'deepseek';
const HELPER_TIMEOUT_MS = 45_000;
const TOKEN_HELPER_ENV_KEYS = ['ROUTECODEX_DEEPSEEK_TOKEN_HELPER', 'RCC_DEEPSEEK_TOKEN_HELPER'];
const LOGIN_URL_ENV_KEYS = ['ROUTECODEX_DEEPSEEK_LOGIN_URL', 'RCC_DEEPSEEK_LOGIN_URL'];
const LOGIN_TIMEOUT_ENV_KEYS = ['ROUTECODEX_DEEPSEEK_LOGIN_TIMEOUT_MS', 'RCC_DEEPSEEK_LOGIN_TIMEOUT_MS'];

type CommandOutput = {
  stdout: string;
  stderr: string;
  code: number;
};

type CamoufoxFingerprintSnapshot = {
  userAgent?: string;
  platform?: string;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function createDeepSeekAuthError(params: {
  code: DeepSeekErrorCode;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
}): DeepSeekAuthError {
  const error = new Error(params.message) as DeepSeekAuthError;
  error.code = params.code;
  if (typeof params.statusCode === 'number') {
    error.statusCode = params.statusCode;
    error.status = params.statusCode;
  }
  if (params.details) {
    error.details = params.details;
  }
  return error;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sanitizeAlias(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function parseAliasFromTokenFile(tokenFilePath: string): string {
  const base = path.basename(tokenFilePath);
  const match = base.match(/^deepseek-account-(.+)\.json$/i);
  if (match && normalizeString(match[1])) {
    return sanitizeAlias(String(match[1]));
  }
  return 'default';
}

function resolveAuthDirFromTokenFile(tokenFilePath: string): string {
  const dir = path.dirname(tokenFilePath);
  if (normalizeString(dir)) {
    return dir;
  }
  return DEFAULT_AUTH_DIR;
}

function parseTokenFromUnknown(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = parseTokenFromUnknown(item);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = normalizeString(
    record.access_token ??
      record.AccessToken ??
      record.token ??
      record.accessToken ??
      record.api_key ??
      record.apiKey
  );
  if (direct) {
    return direct;
  }
  const nestedNodes = [
    record.data,
    record.result,
    record.payload,
    record.response,
    record.body,
    record.biz_data,
    record.bizData,
    record.user,
    record.token_data,
    record.tokenData
  ];
  for (const next of nestedNodes) {
    const nested = parseTokenFromUnknown(next);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function readBooleanLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function readEnvBoolean(keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim()) {
      return readBooleanLike(raw, fallback);
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCamoufoxConfig(payload: unknown): CamoufoxFingerprintSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const envNode = payload.env;
  if (!isRecord(envNode)) {
    return null;
  }
  const rawConfig = normalizeString(envNode.CAMOU_CONFIG_1);
  if (!rawConfig) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    userAgent: normalizeString(parsed['navigator.userAgent']),
    platform: normalizeString(parsed['navigator.platform'])
  };
}

function mapPlatformToClientPlatform(platform?: string): string | undefined {
  const normalized = normalizeString(platform)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes('win')) {
    return 'windows';
  }
  if (normalized.includes('mac')) {
    return 'macos';
  }
  if (normalized.includes('linux') || normalized.includes('x11')) {
    return 'linux';
  }
  return undefined;
}

function shouldUseCamoufoxFingerprintForLogin(): boolean {
  return readEnvBoolean([
    'ROUTECODEX_DEEPSEEK_CAMOUFOX_FINGERPRINT',
    'RCC_DEEPSEEK_CAMOUFOX_FINGERPRINT'
  ], true);
}

function shouldAutoGenerateCamoufoxFingerprintForLogin(): boolean {
  return readEnvBoolean([
    'ROUTECODEX_DEEPSEEK_CAMOUFOX_AUTO_GENERATE',
    'RCC_DEEPSEEK_CAMOUFOX_AUTO_GENERATE'
  ], true);
}

function resolveCamoufoxProviderFamily(): string {
  return normalizeString(
    process.env.ROUTECODEX_DEEPSEEK_CAMOUFOX_PROVIDER ||
      process.env.RCC_DEEPSEEK_CAMOUFOX_PROVIDER
  ) || DEFAULT_CAMOUFOX_PROVIDER;
}

async function loadCamoufoxFingerprint(providerFamily: string, alias: string): Promise<CamoufoxFingerprintSnapshot | null> {
  if (shouldAutoGenerateCamoufoxFingerprintForLogin()) {
    ensureCamoufoxFingerprintForToken(providerFamily, alias);
  }
  const profileDir = getCamoufoxProfileDir(providerFamily, alias);
  const profileId = path.basename(profileDir);
  if (!profileId) {
    return null;
  }
  const filePath = path.join((process.env.HOME || os.homedir()), '.routecodex', 'camoufox-fp', `${profileId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const payload = raw.trim() ? JSON.parse(raw) : null;
    return parseCamoufoxConfig(payload);
  } catch {
    return null;
  }
}

function buildDeepSeekBrowserHeaders(fingerprint: CamoufoxFingerprintSnapshot | null): Record<string, string> {
  const userAgent = normalizeString(fingerprint?.userAgent) || DEFAULT_DEEPSEEK_USER_AGENT;
  const clientPlatform = mapPlatformToClientPlatform(fingerprint?.platform) || 'android';
  return {
    'User-Agent': userAgent,
    'x-client-platform': clientPlatform,
    'x-client-version': '1.3.0-auto-resume',
    'x-client-locale': 'zh_CN',
    'accept-charset': 'UTF-8',
    Origin: 'https://chat.deepseek.com',
    Referer: 'https://chat.deepseek.com/',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty'
  };
}

async function resolveDeepSeekLoginHeaders(alias: string): Promise<Record<string, string>> {
  if (!shouldUseCamoufoxFingerprintForLogin()) {
    return buildDeepSeekBrowserHeaders(null);
  }
  const providerFamily = resolveCamoufoxProviderFamily();
  const fingerprint = await loadCamoufoxFingerprint(providerFamily, alias);
  return buildDeepSeekBrowserHeaders(fingerprint);
}

function pickEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeString(process.env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeAliasForEnv(alias: string): string {
  return alias.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'DEFAULT';
}

function parseCredentialNode(raw: unknown): DeepSeekCredential | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const node = raw as Record<string, unknown>;
  const mobile = normalizeString(node.mobile ?? node.phone ?? node.account ?? node.username);
  const password = normalizeString(node.password ?? node.pass ?? node.secret);
  if (!mobile || !password) {
    return null;
  }
  return { mobile, password };
}

async function resolveCredentialFromFile(filePath: string): Promise<DeepSeekCredential | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = tryParseJson(raw);
    return parseCredentialNode(parsed);
  } catch {
    return null;
  }
}

async function resolveDeepSeekCredential(
  authDir: string,
  alias: string,
  tokenFileCredential?: DeepSeekCredential | null
): Promise<DeepSeekCredential | null> {
  if (tokenFileCredential) {
    return tokenFileCredential;
  }

  const aliasEnv = normalizeAliasForEnv(alias);
  const envMobile = normalizeString(process.env[`ROUTECODEX_DEEPSEEK_ACCOUNT_${aliasEnv}_MOBILE`]);
  const envPassword = normalizeString(process.env[`ROUTECODEX_DEEPSEEK_ACCOUNT_${aliasEnv}_PASSWORD`]);
  if (envMobile && envPassword) {
    return { mobile: envMobile, password: envPassword };
  }

  const aliasSpecificFiles = [
    path.join(authDir, `deepseek-account-${alias}.credentials.json`),
    path.join(authDir, `deepseek-account-${alias}.account.json`),
    path.join(authDir, `deepseek-account-${alias}.login.json`)
  ];

  for (const candidate of aliasSpecificFiles) {
    const credential = await resolveCredentialFromFile(candidate);
    if (credential) {
      return credential;
    }
  }

  const indexFilePath = path.join(authDir, 'deepseek-account-credentials.json');
  try {
    const raw = await fs.readFile(indexFilePath, 'utf8');
    const parsed = tryParseJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const node = parsed as Record<string, unknown>;
      const accountsNode = node.accounts;
      if (accountsNode && typeof accountsNode === 'object' && !Array.isArray(accountsNode)) {
        const account = (accountsNode as Record<string, unknown>)[alias];
        const credential = parseCredentialNode(account);
        if (credential) {
          return credential;
        }
      }
      const aliasNode = node[alias];
      const aliasCredential = parseCredentialNode(aliasNode);
      if (aliasCredential) {
        return aliasCredential;
      }
    }
  } catch {
    // ignore index file failures
  }

  return null;
}

async function readTokenFileSnapshot(tokenFilePath: string): Promise<TokenFileSnapshot> {
  try {
    const raw = await fs.readFile(tokenFilePath, 'utf8');
    const parsed = tryParseJson(raw);
    if (parsed !== undefined) {
      if (isRecord(parsed)) {
        return {
          token: parseTokenFromUnknown(parsed),
          credential: parseCredentialNode(parsed),
          sourceObject: parsed
        };
      }
      return {
        token: parseTokenFromUnknown(parsed),
        credential: null,
        sourceObject: null
      };
    }
    return {
      token: parseTokenFromUnknown(raw),
      credential: null,
      sourceObject: null
    };
  } catch {
    return {
      token: undefined,
      credential: null,
      sourceObject: null
    };
  }
}

async function writeTokenFile(params: {
  tokenFilePath: string;
  token: string;
  alias: string;
  credential?: DeepSeekCredential | null;
  sourceObject?: Record<string, unknown> | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...(params.sourceObject || {}),
    access_token: params.token,
    token: params.token,
    account_alias: params.alias,
    ...(params.credential?.mobile ? { mobile: params.credential.mobile } : {}),
    ...(params.credential?.password ? { password: params.credential.password } : {}),
    created_at:
      normalizeString((params.sourceObject || {}).created_at) ||
      nowIso,
    updated_at: nowIso
  };
  await fs.mkdir(path.dirname(params.tokenFilePath), { recursive: true });
  await fs.writeFile(params.tokenFilePath, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600
  });
}

function resolveCommandTimeoutMs(): number {
  const raw = normalizeString(process.env.ROUTECODEX_DEEPSEEK_TOKEN_HELPER_TIMEOUT_MS);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return HELPER_TIMEOUT_MS;
}

async function runShellCommand(command: string, stdin: string, timeoutMs: number): Promise<CommandOutput> {
  return await new Promise<CommandOutput>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`DeepSeek token helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: typeof code === 'number' ? code : 1
      });
    });
    child.stdin.end(stdin);
  });
}

async function acquireTokenByHelperCommand(input: {
  command: string;
  alias: string;
  tokenFilePath: string;
  credential: DeepSeekCredential | null;
  reason: EnsureDeepSeekTokenReason;
}): Promise<string> {
  const payload = {
    provider: 'deepseek-account',
    alias: input.alias,
    tokenFile: input.tokenFilePath,
    reason: input.reason,
    credentials: input.credential ? { ...input.credential } : null
  };
  const output = await runShellCommand(
    input.command,
    JSON.stringify(payload) + '\n',
    resolveCommandTimeoutMs()
  );

  if (output.code !== 0) {
    const stderr = normalizeString(output.stderr) || '(empty stderr)';
    throw new Error(`DeepSeek token helper exited with code ${output.code}: ${stderr}`);
  }

  const stdout = normalizeString(output.stdout);
  if (!stdout) {
    throw new Error('DeepSeek token helper returned empty stdout');
  }

  const parsed = tryParseJson(stdout);
  const token = parseTokenFromUnknown(parsed !== undefined ? parsed : stdout);
  if (!token) {
    throw new Error('DeepSeek token helper output has no token field');
  }
  return token;
}

function resolveLoginTimeoutMs(): number {
  const raw = pickEnv(LOGIN_TIMEOUT_ENV_KEYS);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 15_000;
}

async function acquireTokenByHttpLogin(input: {
  loginUrl: string;
  alias: string;
  credential: DeepSeekCredential;
}): Promise<string> {
  const timeoutMs = resolveLoginTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const loginHeaders = await resolveDeepSeekLoginHeaders(input.alias);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  const deviceId = crypto.randomUUID();
  const payloadCandidates: Record<string, unknown>[] = [
    {
      mobile: input.credential.mobile,
      password: input.credential.password,
      device_id: deviceId,
      os: 'android'
    },
    {
      mobile: input.credential.mobile,
      password: input.credential.password,
      phone: input.credential.mobile,
      username: input.credential.mobile,
      account: input.credential.mobile,
      device_id: deviceId,
      os: 'android'
    },
    {
      mobile: input.credential.mobile,
      password: input.credential.password,
      phone: input.credential.mobile,
      username: input.credential.mobile,
      account: input.credential.mobile,
      client_id: deviceId,
      device_id: deviceId,
      os: 'android',
      area_code: '86'
    }
  ];

  try {
    let lastMessage = '';
    for (const payload of payloadCandidates) {
      const response = await fetch(input.loginUrl, {
        method: 'POST',
        headers: {
          ...loginHeaders,
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const raw = await response.text();
      const parsed = tryParseJson(raw);
      const token = parseTokenFromUnknown(parsed !== undefined ? parsed : raw);
      if (token) {
        return token;
      }
      const bizMessage = normalizeString(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>).data &&
              typeof (parsed as Record<string, unknown>).data === 'object' &&
              !Array.isArray((parsed as Record<string, unknown>).data)
              ? ((parsed as Record<string, unknown>).data as Record<string, unknown>).biz_msg
              : undefined)
          : undefined
      );
      const responseMessage = normalizeString(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).message ??
              (parsed as Record<string, unknown>).msg ??
              (parsed as Record<string, unknown>).error
          : undefined
      );
      lastMessage = bizMessage || responseMessage || `status=${response.status}`;
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    }
    throw new Error(lastMessage || 'DeepSeek HTTP login returned no token');
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureDeepSeekAccountToken(
  options: EnsureDeepSeekAccountTokenOptions
): Promise<EnsureDeepSeekAccountTokenResult> {
  const tokenFilePath = path.resolve(options.tokenFilePath);
  const accountAlias = sanitizeAlias(options.accountAlias || parseAliasFromTokenFile(tokenFilePath));
  const reason = options.reason || 'initialize';
  const authDir = resolveAuthDirFromTokenFile(tokenFilePath);
  const tokenFileSnapshot = await readTokenFileSnapshot(tokenFilePath);

  if (!options.forceAcquire) {
    const existing = tokenFileSnapshot.token;
    if (existing) {
      return {
        token: existing,
        tokenFilePath,
        accountAlias,
        acquired: false,
        source: 'token-file'
      };
    }
  }

  const credential = await resolveDeepSeekCredential(authDir, accountAlias, tokenFileSnapshot.credential);
  const helperCommand = pickEnv(TOKEN_HELPER_ENV_KEYS);
  if (helperCommand) {
    let token: string;
    try {
      token = await acquireTokenByHelperCommand({
        command: helperCommand,
        alias: accountAlias,
        tokenFilePath,
        credential,
        reason
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_INVALID,
        statusCode: 401,
        message: `DeepSeek token helper acquire failed for alias=${accountAlias}: ${message}`,
        details: {
          tokenFile: tokenFilePath,
          accountAlias,
          reason
        }
      });
    }
    await writeTokenFile({
      tokenFilePath,
      token,
      alias: accountAlias,
      credential,
      sourceObject: tokenFileSnapshot.sourceObject
    });
    return {
      token,
      tokenFilePath,
      accountAlias,
      acquired: true,
      source: 'helper-command'
    };
  }

  const loginUrl = pickEnv(LOGIN_URL_ENV_KEYS) || DEFAULT_DEEPSEEK_LOGIN_URL;
  if (loginUrl && credential) {
    let token: string;
    try {
      token = await acquireTokenByHttpLogin({
        loginUrl,
        alias: accountAlias,
        credential
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_INVALID,
        statusCode: 401,
        message: `DeepSeek login failed for alias=${accountAlias}: ${message}`,
        details: {
          tokenFile: tokenFilePath,
          accountAlias,
          reason,
          loginUrl
        }
      });
    }
    await writeTokenFile({
      tokenFilePath,
      token,
      alias: accountAlias,
      credential,
      sourceObject: tokenFileSnapshot.sourceObject
    });
    return {
      token,
      tokenFilePath,
      accountAlias,
      acquired: true,
      source: 'http-login'
    };
  }

  throw createDeepSeekAuthError({
    code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
    statusCode: 401,
    message:
      `DeepSeek token is missing and auto-acquire is not configured for alias=${accountAlias}. ` +
      `Set ${TOKEN_HELPER_ENV_KEYS.join('/')} or provide ${LOGIN_URL_ENV_KEYS.join('/')} ` +
      `plus mobile/password in tokenFile or credential file under ${authDir}/deepseek-account-${accountAlias}.credentials.json`,
    details: {
      tokenFile: tokenFilePath,
      accountAlias,
      authDir
    }
  });
}
