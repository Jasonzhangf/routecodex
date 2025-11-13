import fetch from 'node-fetch';
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

export async function fetchModelsFromUpstream(provider: ProviderInputConfig, verbose = false): Promise<ModelsList> {
  const type = resolveProviderType(provider.type);
  const baseUrl = (provider.baseUrl || provider.baseURL || '').trim();
  if (!baseUrl) throw new Error('provider.baseUrl/baseURL is required');
  const endpoint = normalizeBaseUrlForModels(baseUrl);
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...buildAuthHeaders(provider.auth)
  };
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

