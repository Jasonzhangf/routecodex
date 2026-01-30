/**
 * Antigravity Cloud Code Assist User-Agent helpers.
 *
 * IMPORTANT (RouteCodex constraint):
 * - Do NOT vary the OS/arch fingerprint per machine.
 * - Use the per-alias OAuth fingerprint (Camoufox) to select the OS/arch suffix, so each alias
 *   stays consistent with its own browser/OAuth session.
 * - Allow the version to refresh to avoid "version no longer supported" rejections.
 */
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inferAntigravityUaSuffixFromFingerprint, loadAntigravityCamoufoxFingerprint } from './antigravity-fingerprint.js';
import { getAntigravityReauthRequiredRecord } from './antigravity-reauth-state.js';

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

type AntigravityUaVersionSource = 'env' | 'remote' | 'disk' | 'legacy';

let cachedVersion: { version: string; fetchedAt: number; source: AntigravityUaVersionSource } | null = null;
let inflightVersion: Promise<string> | null = null;
const aliasSuffixCache = new Map<string, string>();
const aliasSuffixInflight = new Map<string, Promise<string | undefined>>();
let reauthCache: { fetchedAt: number; records: Record<string, { updatedAt: number }> } | null = null;

async function isAliasReauthRequired(alias: string): Promise<boolean> {
  const key = alias.trim().toLowerCase();
  if (!key) {
    return false;
  }
  const now = Date.now();
  if (reauthCache && now - reauthCache.fetchedAt < 2_000) {
    return Boolean(reauthCache.records[key]);
  }
  const record = await getAntigravityReauthRequiredRecord(key);
  reauthCache = {
    fetchedAt: now,
    records: record ? { [key]: { updatedAt: record.updatedAt } } : {}
  };
  return Boolean(record);
}

export function parseAntigravityVersionFromUpdater(text: string): string | undefined {
  const hit = String(text || '').match(VERSION_REGEX)?.[0];
  return hit && hit.trim().length ? hit.trim() : undefined;
}

export function formatAntigravityManagerUserAgent(opts: {
  version: string;
  /**
   * Optional stable fingerprint suffix, e.g. "windows/amd64".
   * If omitted, we use RouteCodex default (only when alias fingerprint is unavailable).
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
      `${JSON.stringify({ version: v, fetchedAt: Date.now(), source: 'remote' }, null, 2)}\n`,
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

async function resolveAntigravityVersion(opts?: {
  /**
   * Refresh cache regardless of TTL.
   */
  forceRefresh?: boolean;
  /**
   * Cache TTL in milliseconds (default: 30 minutes).
   */
  ttlMs?: number;
}): Promise<string> {
  // Optional: allow operators/tests to pin the UA version without specifying a full UA.
  const envVersionRaw = (
    process.env.ROUTECODEX_ANTIGRAVITY_UA_VERSION ||
    process.env.RCC_ANTIGRAVITY_UA_VERSION ||
    ''
  ).trim();
  const envVersion = envVersionRaw && VERSION_REGEX.test(envVersionRaw) ? envVersionRaw : '';

  const ttlMs = typeof opts?.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : 30 * 60_000;
  const now = Date.now();
  if (!opts?.forceRefresh && cachedVersion && now - cachedVersion.fetchedAt < ttlMs) {
    return cachedVersion.version;
  }

  if (inflightVersion) {
    return inflightVersion;
  }

  inflightVersion = (async () => {
    // Yield once to let concurrent callers coalesce.
    await delay(0);
    if (envVersion) {
      cachedVersion = { version: envVersion, fetchedAt: Date.now(), source: 'env' };
      return envVersion;
    }

    const remoteVersion = await fetchRemoteVersion();
    const diskVersion = remoteVersion ? undefined : await readCachedVersionFromDisk();
    const resolvedVersion = remoteVersion || diskVersion || LEGACY_PINNED_VERSION;
    if (remoteVersion) {
      await writeCachedVersionToDisk(remoteVersion);
    }

    cachedVersion = {
      version: resolvedVersion,
      fetchedAt: Date.now(),
      source: remoteVersion ? 'remote' : diskVersion ? 'disk' : 'legacy'
    };
    return resolvedVersion;
  })();

  try {
    return await inflightVersion;
  } finally {
    inflightVersion = null;
  }
}

async function resolveAntigravityUaSuffixForAlias(alias: string): Promise<string | undefined> {
  const key = alias.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  if (await isAliasReauthRequired(key)) {
    throw new Error(
      `Antigravity alias "${key}" requires OAuth re-auth (fingerprint updated). Run: routecodex oauth antigravity-auto antigravity-oauth-*-` +
        `${key}.json`
    );
  }
  if (aliasSuffixCache.has(key)) {
    const cached = aliasSuffixCache.get(key);
    if (cached && cached.startsWith('linux/')) {
      // Never reuse a cached linux suffix; fingerprint may have been repaired on disk.
      aliasSuffixCache.delete(key);
    } else {
      return cached;
    }
  }
  const inflight = aliasSuffixInflight.get(key);
  if (inflight) {
    return inflight;
  }
  const task = (async () => {
    const fp = await loadAntigravityCamoufoxFingerprint(key);
    if (!fp) {
      return undefined;
    }
    const suffix = inferAntigravityUaSuffixFromFingerprint(fp);
    if (suffix && suffix.startsWith('linux/')) {
      throw new Error(
        `Linux fingerprint is not allowed for Antigravity/Gemini (alias="${key}" suffix="${suffix}"). ` +
          `Fix it by regenerating fingerprint + reauth: routecodex camoufox-fp repair --provider antigravity --alias ${key}`
      );
    }
    if (suffix) {
      aliasSuffixCache.set(key, suffix);
    }
    return suffix;
  })();
  aliasSuffixInflight.set(key, task);
  try {
    return await task;
  } finally {
    aliasSuffixInflight.delete(key);
  }
}

export async function preloadAntigravityAliasUserAgents(aliases: string[]): Promise<void> {
  const unique = Array.from(
    new Set(
      (Array.isArray(aliases) ? aliases : [])
        .map((a) => (typeof a === 'string' ? a.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  );
  if (!unique.length) {
    return;
  }
  await Promise.allSettled(unique.map((alias) => resolveAntigravityUaSuffixForAlias(alias)));
}

export async function primeAntigravityUserAgentVersion(): Promise<void> {
  try {
    const version = await resolveAntigravityVersion({ forceRefresh: true });
    const source = cachedVersion?.source || 'legacy';
    console.log(`[antigravity:ua] version=${version} source=${source}`);
  } catch {
    // best-effort
  }
}

export async function resolveAntigravityUserAgent(opts?: {
  /**
   * Optional alias. When present, UA fingerprint suffix is derived from this alias's
   * Camoufox OAuth fingerprint, keeping UA stable per-account.
   */
  alias?: string;
  /**
   * Refresh version cache regardless of TTL.
   */
  forceRefresh?: boolean;
  /**
   * Version cache TTL in milliseconds (default: 30 minutes).
   */
  ttlMs?: number;
}): Promise<string> {
  const envUa = (process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT || process.env.RCC_ANTIGRAVITY_USER_AGENT || '').trim();
  if (envUa) {
    return envUa;
  }

  // Optional: allow operators to force a UA fingerprint suffix without changing the full UA.
  // NOTE: This overrides per-alias fingerprint inference.
  const envSuffix = (process.env.ROUTECODEX_ANTIGRAVITY_UA_SUFFIX || process.env.RCC_ANTIGRAVITY_UA_SUFFIX || '').trim();
  const aliasSuffix =
    !envSuffix && typeof opts?.alias === 'string' && opts.alias.trim()
      ? await resolveAntigravityUaSuffixForAlias(opts.alias)
      : undefined;
  const suffix = envSuffix || aliasSuffix || DEFAULT_FINGERPRINT_SUFFIX;

  const version = await resolveAntigravityVersion({ forceRefresh: opts?.forceRefresh, ttlMs: opts?.ttlMs });
  return formatAntigravityManagerUserAgent({ version, suffix });
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
