import { LOCAL_HOSTS } from '../../constants/index.js';
import { resolvePreferredLocalConnectHost } from '../../utils/local-connect-host.js';

export function normalizePort(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return NaN;
}

export function normalizeConnectHost(host: unknown, fallback: string = LOCAL_HOSTS.IPV4): string {
  const raw = typeof host === 'string' ? host : String(host ?? '');
  return resolvePreferredLocalConnectHost(raw.trim(), fallback);
}
