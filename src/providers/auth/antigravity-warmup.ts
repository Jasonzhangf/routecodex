import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { inferAntigravityUaSuffixFromFingerprint, loadAntigravityCamoufoxFingerprint } from './antigravity-fingerprint.js';
import { resolveAntigravityUserAgent } from './antigravity-user-agent.js';
import { clearAntigravityReauthRequired, getAntigravityReauthRequiredRecord } from './antigravity-reauth-state.js';
import { getCamoufoxProfileDir } from '../core/config/camoufox-launcher.js';

export type AntigravityWarmupCheckResult =
  | {
      ok: true;
      alias: string;
      profileId: string;
      fingerprintOs: string;
      fingerprintArch: string;
      fingerprintPlatform?: string;
      fingerprintOscpu?: string;
      expectedSuffix: string;
      actualSuffix: string;
      actualUserAgent: string;
    }
  | {
      ok: false;
      alias: string;
      profileId: string;
      fingerprintOs?: string;
      fingerprintArch?: string;
      fingerprintPlatform?: string;
      fingerprintOscpu?: string;
      reason:
        | 'missing_fingerprint'
        | 'unrecognized_fingerprint'
        | 'linux_not_allowed'
        | 'reauth_required'
        | 'ua_suffix_mismatch'
        | 'ua_parse_failed'
        | 'ua_resolve_failed';
      expectedSuffix?: string;
      actualSuffix?: string;
      actualUserAgent?: string;
      details?: string;
      tokenFile?: string;
      fromSuffix?: string;
      toSuffix?: string;
    };

export function parseAntigravityUaSuffix(userAgent: string): string | undefined {
  const ua = String(userAgent || '').trim();
  if (!ua) {
    return undefined;
  }
  // Expected format: "antigravity/<version> <os>/<arch>"
  const parts = ua.split(/\s+/g).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const suffix = parts[1] || '';
  return suffix && suffix.trim() ? suffix.trim() : undefined;
}

async function guessAntigravityTokenFile(alias: string): Promise<string | undefined> {
  const normalized = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  if (!normalized) {
    return undefined;
  }
  const home = (process.env.HOME || '').trim() || os.homedir();
  const dir = path.join(home, '.routecodex', 'auth');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((name) => {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.json')) return false;
      if (!lower.includes(`-${normalized}.json`)) return false;
      return lower.startsWith('antigravity-oauth-') || lower.startsWith('gemini-oauth-') || lower.startsWith('gemini-cli-oauth-');
    })
    .map((name) => path.join(dir, name));
  if (!candidates.length) {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const file of candidates) {
    try {
      const st = await fs.stat(file);
      const mtimeMs = typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
      if (!best || mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs };
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return best?.file;
}

export async function warmupCheckAntigravityAlias(alias: string): Promise<AntigravityWarmupCheckResult> {
  const normalizedAlias = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  if (!normalizedAlias) {
    const profileId = 'rc-gemini.unknown';
    return {
      ok: false,
      alias: '',
      profileId,
      reason: 'missing_fingerprint',
      details: 'alias is empty'
    };
  }

  const profileId = (() => {
    try {
      const dir = getCamoufoxProfileDir('antigravity', normalizedAlias);
      return path.basename(dir);
    } catch {
      return `rc-gemini.${normalizedAlias}`;
    }
  })();

  let reauth = await getAntigravityReauthRequiredRecord(normalizedAlias).catch(() => null);
  if (reauth && reauth.provider !== 'antigravity') {
    // Avoid cross-provider alias collisions (e.g. gemini-cli vs antigravity).
    reauth = null;
  }

  const fp = await loadAntigravityCamoufoxFingerprint(normalizedAlias).catch(() => null);
  if (!fp && !reauth) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'missing_fingerprint'
    };
  }

  const expectedSuffix = fp ? inferAntigravityUaSuffixFromFingerprint(fp) : undefined;
  if (!expectedSuffix && fp && !reauth) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'unrecognized_fingerprint'
    };
  }

  const fallbackSuffix = (expectedSuffix || reauth?.toSuffix || reauth?.fromSuffix || '').trim();
  const [fingerprintOs, fingerprintArch] = fallbackSuffix ? fallbackSuffix.split('/') : ['', ''];

  // Strict safety policy: never allow Linux fingerprints for Antigravity/Gemini.
  if (expectedSuffix && expectedSuffix.startsWith('linux/')) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'linux_not_allowed',
      fingerprintOs,
      fingerprintArch,
      fingerprintPlatform: fp?.navigatorPlatform,
      fingerprintOscpu: fp?.navigatorOscpu,
      expectedSuffix,
      details: 'run: routecodex camoufox-fp repair --provider antigravity --alias <alias>'
    };
  }

  // If the operator already re-authenticated and the token file has been updated since we marked the alias,
  // auto-clear the stale reauth-required marker so warmup can continue.
  const guessedTokenFile = reauth && !reauth.tokenFile ? await guessAntigravityTokenFile(normalizedAlias) : undefined;
  const tokenFile = reauth?.tokenFile || guessedTokenFile;
  if (reauth && expectedSuffix && reauth.toSuffix && expectedSuffix === reauth.toSuffix && tokenFile) {
    try {
      const st = await fs.stat(tokenFile);
      // Use mtimeMs (not mtime) for precise comparison.
      if (typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs) && st.mtimeMs > reauth.updatedAt) {
        await clearAntigravityReauthRequired(normalizedAlias);
        reauth = null;
      }
    } catch {
      // ignore: keep the marker if we can't verify freshness
    }
  }

  if (reauth) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'reauth_required',
      fingerprintOs: fingerprintOs || undefined,
      fingerprintArch: fingerprintArch || undefined,
      fingerprintPlatform: fp?.navigatorPlatform,
      fingerprintOscpu: fp?.navigatorOscpu,
      expectedSuffix: expectedSuffix || undefined,
      tokenFile: tokenFile || reauth.tokenFile,
      fromSuffix: reauth.fromSuffix,
      toSuffix: reauth.toSuffix,
      details: `updatedAt=${new Date(reauth.updatedAt).toISOString()}`
    };
  }

  if (!fp) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'missing_fingerprint'
    };
  }

  if (!expectedSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'unrecognized_fingerprint'
    };
  }

  let actualUserAgent = '';
  try {
    // Ensure UA version stays current (avoid "version no longer supported" rejections).
    actualUserAgent = await resolveAntigravityUserAgent({ alias: normalizedAlias, forceRefresh: true });
  } catch (error) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'ua_resolve_failed',
      fingerprintOs,
      fingerprintArch,
      fingerprintPlatform: fp.navigatorPlatform,
      fingerprintOscpu: fp.navigatorOscpu,
      expectedSuffix,
      details: error instanceof Error ? error.message : String(error)
    };
  }

  const actualSuffix = parseAntigravityUaSuffix(actualUserAgent);
  if (!actualSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'ua_parse_failed',
      fingerprintOs,
      fingerprintArch,
      fingerprintPlatform: fp.navigatorPlatform,
      fingerprintOscpu: fp.navigatorOscpu,
      expectedSuffix,
      actualUserAgent
    };
  }

  if (actualSuffix !== expectedSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      profileId,
      reason: 'ua_suffix_mismatch',
      fingerprintOs,
      fingerprintArch,
      fingerprintPlatform: fp.navigatorPlatform,
      fingerprintOscpu: fp.navigatorOscpu,
      expectedSuffix,
      actualSuffix,
      actualUserAgent
    };
  }

  return {
    ok: true,
    alias: normalizedAlias,
    profileId,
    fingerprintOs,
    fingerprintArch,
    fingerprintPlatform: fp.navigatorPlatform,
    fingerprintOscpu: fp.navigatorOscpu,
    expectedSuffix,
    actualSuffix,
    actualUserAgent
  };
}

export function isAntigravityWarmupEnabled(): boolean {
  const raw = (process.env.ROUTECODEX_ANTIGRAVITY_WARMUP || process.env.RCC_ANTIGRAVITY_WARMUP || '').trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

export function getAntigravityWarmupBlacklistDurationMs(): number {
  const raw = (
    process.env.ROUTECODEX_ANTIGRAVITY_WARMUP_BLACKLIST_MS ||
    process.env.RCC_ANTIGRAVITY_WARMUP_BLACKLIST_MS ||
    ''
  ).trim();
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  // Default: long-lived safety lock (1 year) until operator fixes fingerprint/UA config.
  return 365 * 24 * 60 * 60_000;
}
