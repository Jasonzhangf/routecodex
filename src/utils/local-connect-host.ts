import { networkInterfaces } from 'node:os';

import { LOCAL_HOSTS } from '../constants/index.js';

function normalizeHostValue(host: unknown): string {
  return typeof host === 'string' ? host.trim() : String(host ?? '').trim();
}

export function isWildcardBindHost(host: unknown): boolean {
  const normalized = normalizeHostValue(host).toLowerCase();
  return normalized === '' || normalized === '0.0.0.0' || normalized === '::' || normalized === '::0';
}

export function isLoopbackHost(host: unknown): boolean {
  const normalized = normalizeHostValue(host).toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

function listNonInternalIpv4Hosts(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') {
        continue;
      }
      const address = String(entry.address || '').trim();
      if (!address || seen.has(address)) {
        continue;
      }
      seen.add(address);
      out.push(address);
    }
  }
  return out;
}

export function buildLocalProbeHostCandidates(host: unknown): string[] {
  const normalizedHost = normalizeHostValue(host);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = normalizeHostValue(value);
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  if (!isWildcardBindHost(normalizedHost)) {
    push(normalizedHost);
    if (normalizedHost.toLowerCase() === 'localhost') {
      push(LOCAL_HOSTS.IPV4);
    }
    return out;
  }

  for (const address of listNonInternalIpv4Hosts()) {
    push(address);
  }
  push(LOCAL_HOSTS.IPV4);
  push(LOCAL_HOSTS.LOCALHOST);
  return out;
}

export function resolvePreferredLocalConnectHost(host: unknown): string {
  const candidates = buildLocalProbeHostCandidates(host);
  const first = candidates[0];
  if (typeof first !== 'string' || first.length === 0) {
    throw new Error(
      `resolvePreferredLocalConnectHost: no usable host candidate resolved for input=${String(host)} (no-fallback policy)`
    );
  }
  return first;
}
