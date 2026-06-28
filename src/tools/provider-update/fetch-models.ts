import { buildAuthHeaders } from './auth-headers.js';
import { normalizeBaseUrlForModels } from './url-normalize.js';
import type { ModelsList, ProviderInputConfig } from './types.js';

function resolveProviderType(inType?: string): string {
  const t = String(inType || '').toLowerCase();
  if (!t) {return 'openai';}
  if (t.includes('glm')) {return 'glm';}
  if (t.includes('anthropic')) {return 'anthropic';}
  if (t.includes('modelscope')) {return 'modelscope';}
  if (t.includes('openai')) {return 'openai';}
  return t;
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
  Object.assign(headers, buildAuthHeaders(provider.auth));
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
