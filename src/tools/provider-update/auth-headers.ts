import type { AuthConfig } from './types.js';

export function buildAuthHeaders(auth?: AuthConfig): Record<string, string> {
  if (!auth || auth.type !== 'apikey') return {};
  const key = (auth.apiKey || '').trim();
  if (!key) return {};
  const headerName = (auth.headerName || 'Authorization').trim();
  const prefix = (auth.prefix || 'Bearer').trim();
  return { [headerName]: `${prefix} ${key}` };
}

