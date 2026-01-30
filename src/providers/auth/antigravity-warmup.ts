import { inferAntigravityUaSuffixFromFingerprint, loadAntigravityCamoufoxFingerprint } from './antigravity-fingerprint.js';
import { resolveAntigravityUserAgent } from './antigravity-user-agent.js';

export type AntigravityWarmupCheckResult =
  | {
      ok: true;
      alias: string;
      expectedSuffix: string;
      actualSuffix: string;
      actualUserAgent: string;
    }
  | {
      ok: false;
      alias: string;
      reason: 'missing_fingerprint' | 'unrecognized_fingerprint' | 'ua_suffix_mismatch' | 'ua_parse_failed' | 'ua_resolve_failed';
      expectedSuffix?: string;
      actualSuffix?: string;
      actualUserAgent?: string;
      details?: string;
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

export async function warmupCheckAntigravityAlias(alias: string): Promise<AntigravityWarmupCheckResult> {
  const normalizedAlias = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  if (!normalizedAlias) {
    return {
      ok: false,
      alias: '',
      reason: 'missing_fingerprint',
      details: 'alias is empty'
    };
  }

  const fp = await loadAntigravityCamoufoxFingerprint(normalizedAlias);
  if (!fp) {
    return {
      ok: false,
      alias: normalizedAlias,
      reason: 'missing_fingerprint'
    };
  }

  const expectedSuffix = inferAntigravityUaSuffixFromFingerprint(fp);
  if (!expectedSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      reason: 'unrecognized_fingerprint'
    };
  }

  let actualUserAgent = '';
  try {
    actualUserAgent = await resolveAntigravityUserAgent({ alias: normalizedAlias });
  } catch (error) {
    return {
      ok: false,
      alias: normalizedAlias,
      reason: 'ua_resolve_failed',
      expectedSuffix,
      details: error instanceof Error ? error.message : String(error)
    };
  }

  const actualSuffix = parseAntigravityUaSuffix(actualUserAgent);
  if (!actualSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      reason: 'ua_parse_failed',
      expectedSuffix,
      actualUserAgent
    };
  }

  if (actualSuffix !== expectedSuffix) {
    return {
      ok: false,
      alias: normalizedAlias,
      reason: 'ua_suffix_mismatch',
      expectedSuffix,
      actualSuffix,
      actualUserAgent
    };
  }

  return {
    ok: true,
    alias: normalizedAlias,
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

