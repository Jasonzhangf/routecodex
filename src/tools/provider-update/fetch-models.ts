import path from 'path';
import { createProviderOAuthStrategy } from '../../providers/core/config/provider-oauth-configs.js';
import { buildAuthHeaders } from './auth-headers.js';
import { normalizeBaseUrlForModels } from './url-normalize.js';
import type { ModelsList, ProviderInputConfig } from './types.js';
import type { UnknownObject } from '../../types/common-types.js';

function resolveProviderType(inType?: string): string {
  const t = String(inType || '').toLowerCase();
  if (!t) {return 'openai';}
  if (t.includes('glm')) {return 'glm';}
  if (t.includes('qwen')) {return 'qwen';}
  if (t.includes('iflow')) {return 'iflow';}
  if (t.includes('anthropic')) {return 'anthropic';}
  if (t.includes('modelscope')) {return 'modelscope';}
  if (t.includes('openai')) {return 'openai';}
  return t;
}

async function buildOAuthHeaders(provider: ProviderInputConfig, providerKind: string, verbose = false): Promise<Record<string, string>> {
  const auth = provider.auth;
  if (!auth || auth.type !== 'oauth') {return {};}

  // Only providers with predefined OAuth configs are supported here
  const kind = providerKind.toLowerCase();
  if (kind !== 'qwen' && kind !== 'iflow') {
    return {};
  }

  try {
    const overrides: Record<string, unknown> = {};
    const endpoints: { tokenUrl?: string; deviceCodeUrl?: string } = {};
    const client: { clientId?: string; clientSecret?: string; scopes?: string[] } = {};

    if (auth.tokenUrl) {endpoints.tokenUrl = auth.tokenUrl;}
    if (auth.deviceCodeUrl) {endpoints.deviceCodeUrl = auth.deviceCodeUrl;}
    if (Object.keys(endpoints).length > 0) {overrides.endpoints = endpoints;}

    if (auth.clientId) {client.clientId = auth.clientId;}
    if (auth.clientSecret) {client.clientSecret = auth.clientSecret;}
    if (Array.isArray(auth.scopes) && auth.scopes.length > 0) {client.scopes = auth.scopes;}
    if (Object.keys(client).length > 0) {overrides.client = client;}

    // 统一 tokenFile 路径，避免与运行时 OAuth 流程使用不同文件导致重复授权：
    // - 若显式提供 auth.tokenFile，则优先使用；
    // - qwen: 默认 ~/.routecodex/auth/qwen-oauth.json（对齐 oauth-lifecycle 默认）；
    // - iflow: 默认保持 upstream/strategy 内置（通常为 ~/.iflow/oauth_creds.json）。
    const home = process.env.HOME || '';
    const tokenFile =
      (typeof auth.tokenFile === 'string' && auth.tokenFile.trim())
        ? auth.tokenFile.trim()
        : kind === 'qwen'
          ? path.join(home, '.routecodex', 'auth', 'qwen-oauth.json')
          : undefined;

    const strategy = createProviderOAuthStrategy(kind, overrides, tokenFile);

    // Try existing token first
    let token: UnknownObject | null = null;
    try {
      token = await strategy.loadToken();
    } catch {
      token = null;
    }

    let valid = false;
    try {
      if (token && typeof strategy.validateToken === 'function') {
        valid = !!strategy.validateToken(token);
      } else {
        valid = !!token;
      }
    } catch {
      valid = false;
    }

    if (!valid) {
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(`[provider-update] Starting OAuth flow for provider='${kind}' (device/authorization flow may open a browser)...`);
      }
      token = await strategy.authenticate({ openBrowser: true });
      try {
        if (token) {
          await strategy.saveToken(token);
        }
      } catch {
        /* non-fatal */
      }
    } else if (verbose) {
      // eslint-disable-next-line no-console
      console.log(`[provider-update] Reusing existing OAuth token for provider='${kind}'.`);
    }

    const headers: Record<string, string> = {};
    try {
      if (token) {
        const authHeader = strategy.getAuthHeader(token);
        if (authHeader && typeof authHeader === 'string') {
          headers['Authorization'] = authHeader;
        }
      }
    } catch {
      // ignore
    }
    return headers;
  } catch (error) {
    if (verbose) {
      const err = error as { message?: string };
      console.error('[provider-update] OAuth authentication failed:', err?.message ?? String(error));
    }
    return {};
  }
}

export async function fetchModelsFromUpstream(provider: ProviderInputConfig, verbose = false): Promise<ModelsList> {
  const type = resolveProviderType(provider.type);
  const baseUrl = (provider.baseUrl || provider.baseURL || '').trim();
  if (!baseUrl) {throw new Error('provider.baseUrl/baseURL is required');}
  const endpoint = normalizeBaseUrlForModels(baseUrl);
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (provider.auth?.type === 'oauth') {
    const oauthHeaders = await buildOAuthHeaders(provider, type, verbose);
    Object.assign(headers, oauthHeaders);
  } else {
    Object.assign(headers, buildAuthHeaders(provider.auth));
  }
  if (verbose) {
    // eslint-disable-next-line no-console
    console.log(`[provider-update] Fetching models: type=${type} url=${endpoint}`);
  }
  const res = await fetch(endpoint, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetch models failed (${res.status}): ${text.slice(0, 800)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  // Normalize: OpenAI style {object:'list', data:[{id:'...'}]}
  const models: string[] = [];
  try {
    // Gemini: { models: [ { name: 'models/gemini-2.5-flash-lite', ... }, ... ] }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const record = json as { models?: unknown[]; data?: unknown[] };
      if (Array.isArray(record.models)) {
        for (const item of record.models) {
          if (item && typeof item === 'object' && 'name' in item && typeof (item as { name?: string }).name === 'string') {
            const name = (item as { name: string }).name;
            const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
            models.push(id);
          }
        }
      } else if (Array.isArray(record.data)) {
        for (const entry of record.data) {
          if (entry && typeof entry === 'object' && 'id' in entry && typeof (entry as { id?: string }).id === 'string') {
            models.push((entry as { id: string }).id);
          }
        }
      }
    } else if (Array.isArray(json)) {
      for (const entry of json) {
        if (entry && typeof entry === 'object' && 'id' in entry && typeof (entry as { id?: string }).id === 'string') {
          models.push((entry as { id: string }).id);
        } else if (typeof entry === 'string') {
          models.push(entry);
        }
      }
    }
  } catch {
    // ignore parsing errors
  }
  return { models, raw: json };
}
