/**
 * Antigravity Cloud Code Assist User-Agent helpers.
 *
 * IMPORTANT (RouteCodex constraint):
 * - Do NOT vary the OS/arch fingerprint per machine. Antigravity cloudcode oauth sessions
 *   are sensitive to UA drift; changing OS/arch can trigger re-verification.
 * - We keep the historical UA suffix ("windows/amd64") stable, while allowing the version
 *   to refresh to avoid "version no longer supported" rejections.
 */
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const VERSION_REGEX = /\d+\.\d+\.\d+/;
const REMOTE_TIMEOUT_MS = 3_000;

// Legacy pinned version used before we introduced remote fetching.
// Used only as a last resort when:
// - operator didn't set ROUTECODEX_ANTIGRAVITY_USER_AGENT / ROUTECODEX_ANTIGRAVITY_UA_VERSION
// - remote fetch fails (or disabled)
// - local cache is missing/corrupt
const LEGACY_PINNED_VERSION = '1.11.9';
const DEFAULT_FINGERPRINT_SUFFIX = 'windows/amd64';
const VERSION_CACHE_FILE = path.join(os.homedir(), '.routecodex', 'state', 'antigravity-ua-version.json');

let cached: { ua: string; fetchedAt: number } | null = null;
let inflight: Promise<string> | null = null;

export function parseAntigravityVersionFromUpdater(text: string): string | undefined {
  const hit = String(text || '').match(VERSION_REGEX)?.[0];
  return hit && hit.trim().length ? hit.trim() : undefined;
}

export function formatAntigravityManagerUserAgent(opts: {
  version: string;
  /**
   * Optional stable fingerprint suffix, e.g. "windows/amd64".
   * If omitted, we keep the historical RouteCodex default.
   */
  suffix?: string;
}): string {
  const version = String(opts.version || '').trim() || LEGACY_PINNED_VERSION;
  const suffixRaw = String(opts.suffix || '').trim();
  const suffix = suffixRaw || DEFAULT_FINGERPRINT_SUFFIX;
  return `antigravity/${version} ${suffix}`;
}

async function readCachedVersionFromDisk(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(VERSION_CACHE_FILE, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const versionRaw = (parsed as any).version;
    const version = typeof versionRaw === 'string' ? versionRaw.trim() : '';
    if (!version) {
      return undefined;
    }
    return VERSION_REGEX.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedVersionToDisk(version: string): Promise<void> {
  const v = String(version || '').trim();
  if (!v || !VERSION_REGEX.test(v)) {
    return;
  }
  try {
    await fs.mkdir(path.dirname(VERSION_CACHE_FILE), { recursive: true });
    await fs.writeFile(
      VERSION_CACHE_FILE,
      `${JSON.stringify({ version: v, fetchedAt: Date.now() }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // best-effort
  }
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

  // Optional: allow operators to pin the UA fingerprint suffix without changing the full UA.
  const suffix =
    (process.env.ROUTECODEX_ANTIGRAVITY_UA_SUFFIX || process.env.RCC_ANTIGRAVITY_UA_SUFFIX || '').trim() ||
    DEFAULT_FINGERPRINT_SUFFIX;

  // Optional: allow operators/tests to pin the UA version without specifying a full UA.
  const envVersionRaw = (
    process.env.ROUTECODEX_ANTIGRAVITY_UA_VERSION ||
    process.env.RCC_ANTIGRAVITY_UA_VERSION ||
    ''
  ).trim();
  const envVersion = envVersionRaw && VERSION_REGEX.test(envVersionRaw) ? envVersionRaw : '';

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
    if (envVersion) {
      const ua = formatAntigravityManagerUserAgent({ version: envVersion, suffix });
      cached = { ua, fetchedAt: Date.now() };
      return ua;
    }

    const remoteVersion = await fetchRemoteVersion();
    const diskVersion = remoteVersion ? undefined : await readCachedVersionFromDisk();
    const resolvedVersion = remoteVersion || diskVersion || LEGACY_PINNED_VERSION;
    if (remoteVersion) {
      await writeCachedVersionToDisk(remoteVersion);
    }

    const ua = formatAntigravityManagerUserAgent({ version: resolvedVersion, suffix });
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
  const suffix =
    (process.env.ROUTECODEX_ANTIGRAVITY_UA_SUFFIX || process.env.RCC_ANTIGRAVITY_UA_SUFFIX || '').trim() ||
    DEFAULT_FINGERPRINT_SUFFIX;
  const envVersionRaw = (
    process.env.ROUTECODEX_ANTIGRAVITY_UA_VERSION ||
    process.env.RCC_ANTIGRAVITY_UA_VERSION ||
    ''
  ).trim();
  const envVersion = envVersionRaw && VERSION_REGEX.test(envVersionRaw) ? envVersionRaw : '';
  return formatAntigravityManagerUserAgent({ version: envVersion || LEGACY_PINNED_VERSION, suffix });
}
