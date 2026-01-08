/**
 * iFlow Cookie-based Authentication Provider
 *
 * 使用浏览器导出的 iFlow Cookie（BXAuth）获取并维护 API Key，避免频繁走 OAuth 授权码流程。
 * 请求阶段始终以 `Authorization: Bearer <apiKey>` 调用 https://apis.iflow.cn/v1/chat/completions。
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import type { IAuthProvider, AuthStatus } from './auth-interface.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

type IflowCookieConfig = {
  type?: string;
  cookie?: string;
  cookieFile?: string;
  tokenFile?: string;
  email?: string;
};

type IflowKeyData = {
  hasExpired?: boolean;
  expireTime?: string;
  name?: string;
  apiKey?: string;
  apiKeyMask?: string;
};

type IflowAPIKeyResponse = {
  success?: boolean;
  code?: string;
  message?: string;
  data?: IflowKeyData;
  extra?: UnknownObject;
};

function asNonEmptyString(value: unknown): string | '' {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/')) {
    const home = process.env.HOME || '';
    return p.replace(/^~\//, `${home}/`);
  }
  return p;
}

export class IflowCookieAuthProvider implements IAuthProvider {
  readonly type = 'apikey' as const;

  private readonly config: IflowCookieConfig;
  private status: AuthStatus;
  private isInitialized = false;
  private apiKey: string | null = null;
  private expireTime: string | null = null;
  private email: string | null = null;

  constructor(config: UnknownObject) {
    this.config = (config || {}) as IflowCookieConfig;
    this.status = {
      isAuthenticated: false,
      isValid: false,
      lastValidated: 0
    };
  }

  async initialize(): Promise<void> {
    try {
      const cookie = await this.resolveCookie();
      if (!cookie) {
        this.updateStatus(false, false, 'cookie missing');
        throw new Error('IflowCookieAuthProvider: cookie not provided');
      }

      // 对齐 CLIProxyAPI 的流程：先获取现有 API Key 信息，再刷新一次确保最新。
      const initial = await this.fetchApiKeyInfo(cookie);
      const name = asNonEmptyString(initial.name);
      const keyData = await this.refreshApiKey(cookie, name || initial.name || '');

      const apiKey = asNonEmptyString(keyData.apiKey);
      if (!apiKey) {
        this.updateStatus(false, false, 'api key missing from cookie flow');
        throw new Error('IflowCookieAuthProvider: missing api key in response');
      }

      this.apiKey = apiKey;
      this.expireTime = asNonEmptyString(keyData.expireTime);
      this.email = asNonEmptyString(keyData.name);
      this.updateStatus(true, true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || '');
      this.updateStatus(false, false, msg);
      throw error;
    } finally {
      this.isInitialized = true;
    }
  }

  buildHeaders(): Record<string, string> {
    if (!this.isInitialized || !this.apiKey) {
      throw new Error('IflowCookieAuthProvider not initialized');
    }
    return {
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized || !this.apiKey) {
      return false;
    }
    // 简单校验：存在 apiKey 即视为有效；过期判断由服务端和上层重试/刷新策略负责。
    this.updateStatus(true, true);
    return true;
  }

  async cleanup(): Promise<void> {
    this.apiKey = null;
    this.expireTime = null;
    this.email = null;
    this.isInitialized = false;
    this.updateStatus(false, false, 'cleanup');
  }

  getStatus(): AuthStatus {
    return { ...this.status };
  }

  // ---- helpers ----

  private async resolveCookie(): Promise<string> {
    // 1) 显式 cookie 字段
    const direct = asNonEmptyString(this.config.cookie);
    if (direct) {
      return direct;
    }

    // 2) cookieFile / tokenFile 指向的文件
    const fileCandidates: string[] = [];
    const cookieFile = asNonEmptyString(this.config.cookieFile);
    if (cookieFile) {
      fileCandidates.push(cookieFile);
    }
    const tokenFile = asNonEmptyString(this.config.tokenFile);
    if (tokenFile) {
      fileCandidates.push(tokenFile);
    }
    for (const candidate of fileCandidates) {
      const filePath = expandHome(candidate);
      try {
        const txt = await fsPromises.readFile(filePath, 'utf8');
        const content = txt.trim();
        if (content) {
          return content;
        }
      } catch {
        // ignore and try next candidate
      }
    }

    // 3) 环境变量 IFLOW_COOKIE
    const envCookie = asNonEmptyString(process.env.IFLOW_COOKIE);
    if (envCookie) {
      return envCookie;
    }

    return '';
  }

  private async fetchApiKeyInfo(cookie: string): Promise<IflowKeyData> {
    const endpoint = 'https://platform.iflow.cn/api/openapi/apikey';
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'keep-alive'
    };

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      throw new Error(
        `iflow cookie GET request failed: status=${resp.status} body=${bodyText.slice(0, 200)}`
      );
    }

    let parsed: IflowAPIKeyResponse;
    try {
      parsed = JSON.parse(bodyText) as IflowAPIKeyResponse;
    } catch (error) {
      throw new Error(
        `iflow cookie GET decode failed: ${(error as Error).message || String(error)}`
      );
    }

    if (!parsed.success || !parsed.data) {
      throw new Error(
        `iflow cookie GET not successful: ${asNonEmptyString(parsed.message)}`
      );
    }

    return parsed.data;
  }

  private async refreshApiKey(cookie: string, name: string): Promise<IflowKeyData> {
    const trimmedName = asNonEmptyString(name);
    if (!trimmedName) {
      // 若缺少 name，则直接重用 fetchApiKeyInfo 的结果
      return await this.fetchApiKeyInfo(cookie);
    }

    const endpoint = 'https://platform.iflow.cn/api/openapi/apikey';
    const headers: Record<string, string> = {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'keep-alive',
      Origin: 'https://platform.iflow.cn',
      Referer: 'https://platform.iflow.cn/'
    };

    const body = JSON.stringify({ name: trimmedName });

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      throw new Error(
        `iflow cookie POST request failed: status=${resp.status} body=${bodyText.slice(0, 200)}`
      );
    }

    let parsed: IflowAPIKeyResponse;
    try {
      parsed = JSON.parse(bodyText) as IflowAPIKeyResponse;
    } catch (error) {
      throw new Error(
        `iflow cookie POST decode failed: ${(error as Error).message || String(error)}`
      );
    }

    if (!parsed.success || !parsed.data) {
      throw new Error(
        `iflow cookie POST not successful: ${asNonEmptyString(parsed.message)}`
      );
    }

    return parsed.data;
  }

  private updateStatus(isAuthenticated: boolean, isValid: boolean, message?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      error: message
    };
  }
}
