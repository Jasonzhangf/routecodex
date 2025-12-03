import fetch from 'node-fetch';
import path from 'path';
import { createProviderOAuthStrategy } from '../../providers/core/config/provider-oauth-configs.js';
import { buildAuthHeaders } from './auth-headers.js';
import { normalizeBaseUrlForModels } from './url-normalize.js';
import type { ModelsList, ProviderInputConfig } from './types.js';

function resolveProviderType(inType?: string): string {
  const t = String(inType || '').toLowerCase();
  if (!t) return 'openai';
  if (t.includes('glm')) return 'glm';
  if (t.includes('qwen')) return 'qwen';
  if (t.includes('iflow')) return 'iflow';
  if (t.includes('anthropic')) return 'anthropic';
  if (t.includes('modelscope')) return 'modelscope';
  if (t.includes('openai')) return 'openai';
  return t;
}

async function buildOAuthHeaders(provider: ProviderInputConfig, providerKind: string, verbose = false): Promise<Record<string, string>> {
  const auth = provider.auth;
  if (!auth || auth.type !== 'oauth') return {};

  // Only providers with predefined OAuth configs are supported here
  const kind = providerKind.toLowerCase();
  if (kind !== 'qwen' && kind !== 'iflow') {
    return {};
  }

  try {
    const overrides: Record<string, unknown> = {};
    const endpoints: any = {};
    const client: any = {};

    if (auth.tokenUrl) endpoints.tokenUrl = auth.tokenUrl;
    if (auth.deviceCodeUrl) endpoints.deviceCodeUrl = auth.deviceCodeUrl;
    if (Object.keys(endpoints).length > 0) overrides.endpoints = endpoints;

    if (auth.clientId) client.clientId = auth.clientId;
    if (auth.clientSecret) client.clientSecret = auth.clientSecret;
    if (Array.isArray(auth.scopes) && auth.scopes.length > 0) client.scopes = auth.scopes;
    if (Object.keys(client).length > 0) overrides.client = client;

    // 统一 tokenFile 路径，避免与运行时 OAuth 流程使用不同文件导致重复授权：
    // - qwen: ~/.routecodex/auth/qwen-oauth.json （对齐 oauth-lifecycle 默认）
    // - iflow: 保持默认（~/.iflow/oauth_creds.json）
    const home = process.env.HOME || '';
    const tokenFile =
      kind === 'qwen'
        ? path.join(home, '.routecodex', 'auth', 'qwen-oauth.json')
        : undefined;

    const strategy: any = createProviderOAuthStrategy(kind, overrides, tokenFile);

    // Try existing token first
    let token: any = null;
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
        await strategy.saveToken(token);
      } catch {
        /* non-fatal */
      }
    } else if (verbose) {
      // eslint-disable-next-line no-console
      console.log(`[provider-update] Reusing existing OAuth token for provider='${kind}'.`);
    }

    let hdrs: Record<string, string> = {};
    try {
      const h = await strategy.getAuthorizationHeader(token);
      if (h && typeof h === 'object') {
        hdrs = Object.entries(h).reduce((acc, [k, v]) => {
          if (typeof v === 'string') acc[k] = v;
          return acc;
        }, {} as Record<string, string>);
      }
    } catch {
      hdrs = {};
    }
    return hdrs;
  } catch (e) {
    if (verbose) {
      // eslint-disable-next-line no-console
      console.error('[provider-update] OAuth authentication failed:', (e as any)?.message || String(e));
    }
    return {};
  }
}

export async function fetchModelsFromUpstream(provider: ProviderInputConfig, verbose = false): Promise<ModelsList> {
  const type = resolveProviderType(provider.type);
  const baseUrl = (provider.baseUrl || provider.baseURL || '').trim();
  if (!baseUrl) throw new Error('provider.baseUrl/baseURL is required');
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
  const res = await fetch(endpoint, { method: 'GET', headers } as any);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetch models failed (${res.status}): ${text.slice(0, 800)}`);
  }
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  // Normalize: OpenAI style {object:'list', data:[{id:'...'}]}
  const models: string[] = [];
  try {
    // Gemini: { models: [ { name: 'models/gemini-2.5-flash-lite', ... }, ... ] }
    if (json && typeof json === 'object' && Array.isArray((json as any).models)) {
      for (const it of (json as any).models) {
        const name = typeof it?.name === 'string' ? it.name : undefined;
        if (name) {
          const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
          models.push(String(id));
        }
      }
    }
    if (Array.isArray(json)) {
      for (const it of json) {
        const id = typeof it?.id === 'string' ? it.id : (typeof it === 'string' ? it : undefined);
        if (id) models.push(String(id));
      }
    } else if (json && typeof json === 'object') {
      const data = Array.isArray((json as any).data) ? (json as any).data : [];
      for (const it of data) {
        const id = typeof it?.id === 'string' ? it.id : undefined;
        if (id) models.push(String(id));
      }
    }
  } catch { /* ignore */ }
  return { models, raw: json };
}
