import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ApiKeyAuth } from '../core/api/provider-config.js';
import {
  DEEPSEEK_ERROR_CODES,
  type DeepSeekErrorCode
} from '../core/contracts/deepseek-provider-contract.js';
import { ensureDeepSeekAccountToken, type EnsureDeepSeekTokenReason } from './deepseek-account-token-acquirer.js';
import type { AuthStatus, IAuthProvider } from './auth-interface.js';

const DEFAULT_TOKEN_DIR = '.routecodex/auth';
const DEFAULT_TOKEN_FILE_PREFIX = 'deepseek-account';
const TOKEN_FILE_RELOAD_INTERVAL_MS = 1_000;

type DeepSeekAccountConfig = ApiKeyAuth & {
  mobile?: string;
  email?: string;
  password?: string;
  accountFile?: string;
  accountAlias?: string;
};

type DeepSeekStoredTokenRecord = {
  access_token?: string;
  token?: string;
  account_alias?: string;
  alias?: string;
  accountAlias?: string;
};

type DeepSeekAuthError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith('~')) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function sanitizeFileSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function parseAliasFromTokenFilePath(tokenFilePath: string): string | undefined {
  const basename = path.basename(tokenFilePath);
  const match = basename.match(/^deepseek-account-(.+)\.json$/i);
  if (!match || !normalizeString(match[1])) {
    return undefined;
  }
  return sanitizeFileSegment(String(match[1]));
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

export class DeepSeekAccountAuthProvider implements IAuthProvider {
  readonly type = 'apikey' as const;

  private readonly config: DeepSeekAccountConfig;
  private readonly tokenFilePath: string;

  private accessToken: string | null = null;
  private isInitialized = false;
  private lastTokenFileMtime: number | null = null;
  private lastTokenCheckAt = 0;
  private status: AuthStatus = {
    isAuthenticated: false,
    isValid: false,
    lastValidated: 0
  };

  constructor(config: DeepSeekAccountConfig) {
    this.config = config;
    this.tokenFilePath = this.resolveTokenFilePath();
  }

  async initialize(): Promise<void> {
    try {
      this.assertTokenFileOnlyAuthScheme();
      await this.ensureTokenWithAutoAcquire('initialize', false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(false, false, message);
      throw error;
    }
  }

  buildHeaders(): Record<string, string> {
    if (!this.isInitialized || !this.accessToken) {
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
        message: 'DeepSeek account auth is not initialized',
        statusCode: 401
      });
    }

    return {
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async validateCredentials(): Promise<boolean> {
    await this.tryReloadTokenFromFile();
    const token = this.accessToken;
    const valid = Boolean(this.isInitialized && token && token.trim());
    this.updateStatus(valid, valid, valid ? undefined : 'DeepSeek token missing');
    return valid;
  }

  async refreshCredentials(): Promise<void> {
    this.assertTokenFileOnlyAuthScheme();
    try {
      await this.ensureTokenWithAutoAcquire('refresh', true);
    } catch (error) {
      if (this.isDeepSeekAuthError(error, DEEPSEEK_ERROR_CODES.AUTH_MISSING)) {
        // Backward compatibility: if auto-acquire is not configured, keep the
        // previous tokenFile hot-reload behavior.
        await this.forceReloadTokenFromFile();
        return;
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.accessToken = null;
    this.isInitialized = false;
    this.lastTokenFileMtime = null;
    this.lastTokenCheckAt = 0;
    this.updateStatus(false, false, 'cleanup');
  }

  getStatus(): AuthStatus {
    return { ...this.status };
  }

  private updateStatus(isAuthenticated: boolean, isValid: boolean, error?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      error: error && error.trim() ? error : undefined
    };
  }

  private async tryReloadTokenFromFile(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTokenCheckAt < TOKEN_FILE_RELOAD_INTERVAL_MS) {
      return;
    }
    this.lastTokenCheckAt = now;
    const mtime = await this.readTokenFileMtime();
    if (mtime === null) {
      return;
    }
    if (this.lastTokenFileMtime !== null && mtime <= this.lastTokenFileMtime) {
      return;
    }
    const persistedToken = await this.readPersistedToken();
    if (!persistedToken) {
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
        message: `DeepSeek token refresh failed. tokenFile has no token: ${this.tokenFilePath}`,
        statusCode: 401,
        details: { tokenFile: this.tokenFilePath }
      });
    }
    this.accessToken = persistedToken;
    this.lastTokenFileMtime = mtime;
    this.isInitialized = true;
    this.updateStatus(true, true);
  }

  private async forceReloadTokenFromFile(): Promise<void> {
    const persistedToken = await this.readPersistedToken();
    if (!persistedToken) {
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
        message: `DeepSeek token refresh failed. tokenFile has no token: ${this.tokenFilePath}`,
        statusCode: 401,
        details: { tokenFile: this.tokenFilePath }
      });
    }
    this.accessToken = persistedToken;
    this.lastTokenFileMtime = await this.readTokenFileMtime();
    this.lastTokenCheckAt = Date.now();
    this.isInitialized = true;
    this.updateStatus(true, true);
  }

  private async ensureTokenWithAutoAcquire(reason: EnsureDeepSeekTokenReason, forceAcquire: boolean): Promise<void> {
    const result = await ensureDeepSeekAccountToken({
      tokenFilePath: this.tokenFilePath,
      accountAlias: this.resolveAccountAlias(),
      reason,
      forceAcquire
    });

    this.accessToken = result.token;
    this.lastTokenFileMtime = await this.readTokenFileMtime();
    this.lastTokenCheckAt = Date.now();
    this.isInitialized = true;
    this.updateStatus(true, true);
  }

  private async readTokenFileMtime(): Promise<number | null> {
    try {
      const stats = await fs.stat(this.tokenFilePath);
      return typeof stats.mtimeMs === 'number' && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
    } catch {
      return null;
    }
  }

  private resolveTokenFilePath(): string {
    const configured = this.resolveConfigValue(this.config.tokenFile, 'tokenFile');
    if (configured) {
      return expandHome(configured);
    }

    const alias = this.resolveConfigValue(this.config.accountAlias, 'accountAlias') || 'default';
    const fileName = DEFAULT_TOKEN_FILE_PREFIX + '-' + sanitizeFileSegment(alias) + '.json';
    return path.join(os.homedir(), DEFAULT_TOKEN_DIR, fileName);
  }

  private resolveAccountAlias(): string {
    const parsedFromTokenFile = parseAliasFromTokenFilePath(this.tokenFilePath);
    if (parsedFromTokenFile) {
      return parsedFromTokenFile;
    }
    const configured = this.resolveConfigValue(this.config.accountAlias, 'accountAlias');
    if (configured) {
      return sanitizeFileSegment(configured);
    }
    return 'default';
  }

  private assertTokenFileOnlyAuthScheme(): void {
    const invalidFields: string[] = [];

    if (this.resolveConfigValue(this.config.apiKey, 'apiKey')) {
      invalidFields.push('apiKey');
    }
    if (this.resolveConfigValue(this.config.mobile, 'mobile')) {
      invalidFields.push('mobile');
    }
    if (this.resolveConfigValue(this.config.email, 'email')) {
      invalidFields.push('email');
    }
    if (this.resolveConfigValue(this.config.password, 'password')) {
      invalidFields.push('password');
    }
    if (this.resolveConfigValue(this.config.accountFile, 'accountFile')) {
      invalidFields.push('accountFile');
    }

    if (invalidFields.length > 0) {
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_INVALID,
        message:
          `DeepSeek rawType=deepseek-account only supports fingerprint tokenFile auth; unsupported fields: ${invalidFields.join(', ')}`,
        statusCode: 400,
        details: {
          unsupportedFields: invalidFields,
          tokenFile: this.tokenFilePath
        }
      });
    }
  }

  private async readPersistedToken(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.tokenFilePath, 'utf8');
      const parsed = this.safeParseJson(raw);
      if (parsed !== undefined) {
        if (typeof parsed === 'string') {
          return normalizeString(parsed);
        }
        if (isRecord(parsed)) {
          const record = parsed as DeepSeekStoredTokenRecord;
          return normalizeString(record.access_token ?? record.token);
        }
        return undefined;
      }

      const plainToken = normalizeString(raw);
      if (plainToken && !plainToken.startsWith('{') && !plainToken.startsWith('[')) {
        return plainToken;
      }

      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_INVALID,
        message: `DeepSeek token file format invalid: ${this.tokenFilePath}`,
        statusCode: 500,
        details: { tokenFile: this.tokenFilePath }
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined;
      }
      if (error instanceof Error && (error as DeepSeekAuthError).code) {
        throw error;
      }
      throw createDeepSeekAuthError({
        code: DEEPSEEK_ERROR_CODES.AUTH_INVALID,
        message: 'DeepSeek token file read failed: ' + (error instanceof Error ? error.message : String(error)),
        statusCode: 500,
        details: { tokenFile: this.tokenFilePath }
      });
    }
  }

  private safeParseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private isDeepSeekAuthError(error: unknown, code: string): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' && value === code;
  }

  private resolveConfigValue(value: unknown, fieldName: string): string | undefined {
    const normalized = normalizeString(value);
    if (!normalized) {
      return undefined;
    }

    const envWrappedMatch = normalized.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (envWrappedMatch) {
      const envName = envWrappedMatch[1];
      const envValue = normalizeString(process.env[envName]);
      if (!envValue) {
        throw createDeepSeekAuthError({
          code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
          message: `DeepSeek ${fieldName} references undefined env: ${envName}`,
          statusCode: 401
        });
      }
      return envValue;
    }

    if (/^[A-Z][A-Z0-9_]+$/.test(normalized)) {
      const envValue = normalizeString(process.env[normalized]);
      if (!envValue) {
        throw createDeepSeekAuthError({
          code: DEEPSEEK_ERROR_CODES.AUTH_MISSING,
          message: `DeepSeek ${fieldName} references undefined env: ${normalized}`,
          statusCode: 401
        });
      }
      return envValue;
    }

    return normalized;
  }
}
