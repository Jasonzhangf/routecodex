/**
 * Antigravity Cloud Code Assist User-Agent helpers.
 *
 * Alignment target: Antigravity-Manager
 * - Version source: https://antigravity-auto-updater-974169037036.us-central1.run.app (3s timeout)
 * - UA format: antigravity/{version} {os}/{arch}
 *   where os/arch follow Rust std::env::consts::{OS,ARCH} conventions.
 */
import { setTimeout as delay } from 'node:timers/promises';

const VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const VERSION_REGEX = /\d+\.\d+\.\d+/;
const REMOTE_TIMEOUT_MS = 3_000;

// Last-known-safe fallback. This value is only used when remote fetch is disabled or fails.
const FALLBACK_VERSION = '1.11.9';

let cached: { ua: string; fetchedAt: number } | null = null;
let inflight: Promise<string> | null = null;

export function parseAntigravityVersionFromUpdater(text: string): string | undefined {
  const hit = String(text || '').match(VERSION_REGEX)?.[0];
  return hit && hit.trim().length ? hit.trim() : undefined;
}

export function normalizeAntigravityManagerOs(platform: string): string {
  const p = String(platform || '').trim().toLowerCase();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  // Best effort: keep a stable token, avoid spaces.
  return p.replace(/\s+/g, '-') || 'unknown';
}

export function normalizeAntigravityManagerArch(arch: string): string {
  const a = String(arch || '').trim().toLowerCase();
  if (a === 'x64' || a === 'amd64') return 'x86_64';
  if (a === 'arm64' || a === 'aarch64') return 'aarch64';
  return a.replace(/\s+/g, '-') || 'unknown';
}

export function formatAntigravityManagerUserAgent(opts: {
  version: string;
  platform?: string;
  arch?: string;
}): string {
  const version = String(opts.version || '').trim() || FALLBACK_VERSION;
  const os = normalizeAntigravityManagerOs(opts.platform ?? process.platform);
  const arch = normalizeAntigravityManagerArch(opts.arch ?? process.arch);
  return `antigravity/${version} ${os}/${arch}`;
}

async function fetchRemoteVersion(): Promise<string | undefined> {
  // Allow hermetic builds/tests to disable remote calls.
  const disabled =
    (process.env.ROUTECODEX_ANTIGRAVITY_UA_DISABLE_REMOTE || process.env.RCC_ANTIGRAVITY_UA_DISABLE_REMOTE || '')
      .trim()
      .toLowerCase() === '1';
  if (disabled) {
    return undefined;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(VERSION_URL, { signal: controller.signal });
    const text = await res.text();
    return parseAntigravityVersionFromUpdater(text);
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

export async function resolveAntigravityUserAgent(opts?: {
  /**
   * Refresh cache regardless of TTL.
   */
  forceRefresh?: boolean;
  /**
   * Cache TTL in milliseconds (default: 30 minutes).
   */
  ttlMs?: number;
}): Promise<string> {
  const envUa = (process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT || process.env.RCC_ANTIGRAVITY_USER_AGENT || '').trim();
  if (envUa) {
    return envUa;
  }

  const ttlMs = typeof opts?.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : 30 * 60_000;
  const now = Date.now();
  if (!opts?.forceRefresh && cached && now - cached.fetchedAt < ttlMs) {
    return cached.ua;
  }

  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    // Yield once to let concurrent callers coalesce.
    await delay(0);
    const remoteVersion = await fetchRemoteVersion();
    const ua = formatAntigravityManagerUserAgent({ version: remoteVersion || FALLBACK_VERSION });
    cached = { ua, fetchedAt: Date.now() };
    return ua;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function getAntigravityUserAgentFallback(): string {
  const envUa = (process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT || process.env.RCC_ANTIGRAVITY_USER_AGENT || '').trim();
  if (envUa) {
    return envUa;
  }
  return formatAntigravityManagerUserAgent({ version: FALLBACK_VERSION });
}

