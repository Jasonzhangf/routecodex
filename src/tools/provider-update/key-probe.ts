import fetch from 'node-fetch';
import type { ProviderInputConfig } from './types.js';
import { buildAuthHeaders } from './auth-headers.js';
import { normalizeBaseUrlForModels } from './url-normalize.js';

export async function probeFirstWorkingKey(
  provider: ProviderInputConfig,
  candidates: string[],
  verbose = false
): Promise<string | null> {
  const baseUrl = (provider.baseUrl || provider.baseURL || '').trim();
  if (!baseUrl || candidates.length === 0) {
    return null;
  }
  const url = normalizeBaseUrlForModels(baseUrl);
  for (const key of candidates) {
    try {
      const hdr = buildAuthHeaders({ type: 'apikey', apiKey: key });
      const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...hdr } });
      if (verbose) {
        console.log(`[provider-update] Probe key ${key.slice(0, 6)}... -> ${res.status}`);
      }
      if (res.ok) {
        return key;
      }
      if ([401, 403, 429].includes(res.status)) {
        continue;
      }
    } catch {
      // network error; try next
    }
  }
  return null;
}
