import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type QuotaManagerRecord = Record<string, unknown> & {
  providers?: Record<string, unknown>;
};

type ProviderState = Record<string, unknown> & {
  authIssue?: Record<string, unknown>;
  reason?: unknown;
  inPool?: unknown;
};

export type GoogleAccountVerificationIssue = {
  providerKeys: string[];
  url: string | null;
  inPool: boolean | null;
  reason: string | null;
};

const GOOGLE_VERIFY_FALLBACK_URL = 'https://support.google.com/accounts?p=al_alert';

function resolveQuotaDirPath(): string {
  const envHome = String(process.env.ROUTECODEX_HOME || process.env.HOME || '').trim();
  const home = envHome || os.homedir();
  return path.join(home, '.routecodex', 'quota');
}

function resolveQuotaManagerPath(): string {
  return path.join(resolveQuotaDirPath(), 'quota-manager.json');
}

function resolveProviderErrorLogPath(): string {
  return path.join(resolveQuotaDirPath(), 'provider-errors.ndjson');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeProvider(provider: string): string {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAlias(alias: string): string {
  const trimmed = String(alias || '').trim();
  return trimmed ? trimmed.toLowerCase() : 'default';
}

function sanitizeUrl(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  // Some upstream errors store URL as escaped JSON fragments.
  const normalized = trimmed
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\x26/gi, '&')
    .replace(/\\x3d/gi, '=')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');

  // Prefer strict known verification URL patterns.
  const strictPatterns: RegExp[] = [
    /https:\/\/accounts\.google\.com\/signin\/continue[^\s"'<>)]*/i,
    /https:\/\/support\.google\.com\/accounts\?p=al_alert[^\s"'<>)]*/i
  ];
  for (const pattern of strictPatterns) {
    const matched = normalized.match(pattern);
    const candidate = matched && matched[0] ? normalizeUrlCandidate(matched[0]) : null;
    if (candidate) {
      return candidate;
    }
  }

  // Generic fallback for any https URL-looking segment.
  const generic = normalized.match(/https:\/\/[^\s"'\\)]+/i);
  const genericCandidate = generic && generic[0] ? normalizeUrlCandidate(generic[0]) : null;
  if (genericCandidate) {
    return genericCandidate;
  }

  // If the message clearly indicates Google verification but URL payload is truncated,
  // fall back to Google's guidance page so Camoufox can still open a useful destination.
  if (looksLikeGoogleVerificationMessage(normalized)) {
    return GOOGLE_VERIFY_FALLBACK_URL;
  }

  return null;
}

function normalizeUrlCandidate(candidateRaw: string): string | null {
  const candidate = String(candidateRaw || '').trim().replace(/[\\"']+$/g, '');
  if (!candidate) {
    return null;
  }
  if (candidate.includes('...[truncated') || candidate.includes('…[truncated')) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'accounts.google.com' && host !== 'support.google.com') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function looksLikeGoogleVerificationMessage(input: string): boolean {
  const lowered = String(input || '').toLowerCase();
  return (
    lowered.includes('verify your account') ||
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('accounts.goo...[truncated') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

function isHelpOnlyGoogleUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }
  const lowered = url.toLowerCase();
  return lowered.includes('support.google.com/accounts?p=al_alert');
}

function pickBetterGoogleUrl(current: string | null, candidate: string | null): string | null {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentHelpOnly = isHelpOnlyGoogleUrl(current);
  const candidateHelpOnly = isHelpOnlyGoogleUrl(candidate);
  if (currentHelpOnly && !candidateHelpOnly) {
    return candidate;
  }
  return current;
}

async function findGoogleVerificationUrlFromErrorLog(providerKeys: string[]): Promise<string | null> {
  if (!providerKeys.length) {
    return null;
  }

  const filePath = resolveProviderErrorLogPath();
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return null;
  }

  const targetKeys = new Set(providerKeys.map((key) => key.toLowerCase()));
  let best: string | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    let parsed: Record<string, unknown> | null = null;
    try {
      const obj = JSON.parse(line);
      parsed = isRecord(obj) ? obj : null;
    } catch {
      continue;
    }
    if (!parsed) {
      continue;
    }

    const providerKey = typeof parsed.providerKey === 'string' ? parsed.providerKey.toLowerCase() : '';
    if (!providerKey || !targetKeys.has(providerKey)) {
      continue;
    }

    const details = isRecord(parsed.details) ? (parsed.details as Record<string, unknown>) : null;
    const detailAuthIssue = details && isRecord(details.authIssue) ? (details.authIssue as Record<string, unknown>) : null;

    const fromDetail =
      detailAuthIssue && typeof detailAuthIssue.url === 'string'
        ? sanitizeUrl(String(detailAuthIssue.url))
        : null;
    best = pickBetterGoogleUrl(best, fromDetail);

    const fromMessage = typeof parsed.message === 'string' ? sanitizeUrl(String(parsed.message)) : null;
    best = pickBetterGoogleUrl(best, fromMessage);

    if (best && !isHelpOnlyGoogleUrl(best)) {
      return best;
    }
  }

  return best;
}

export async function findGoogleAccountVerificationIssue(
  providerRaw: string,
  aliasRaw: string
): Promise<GoogleAccountVerificationIssue | null> {
  const provider = normalizeProvider(providerRaw);
  const alias = normalizeAlias(aliasRaw);
  if (!provider || !alias) {
    return null;
  }
  // Currently only Antigravity/Gemini CLI family emits Google account verification URLs.
  if (provider !== 'antigravity' && provider !== 'gemini-cli') {
    return null;
  }

  const filePath = resolveQuotaManagerPath();
  let parsed: QuotaManagerRecord | null = null;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const obj = raw.trim() ? JSON.parse(raw) : null;
    parsed = isRecord(obj) ? (obj as QuotaManagerRecord) : null;
  } catch {
    return null;
  }
  const providers = isRecord(parsed?.providers) ? (parsed!.providers as Record<string, unknown>) : null;
  if (!providers) {
    return null;
  }

  const prefix = `${provider}.${alias}.`;
  const providerKeys: string[] = [];
  let url: string | null = null;
  let reason: string | null = null;
  let inPool: boolean | null = null;

  for (const [key, value] of Object.entries(providers)) {
    if (!key.toLowerCase().startsWith(prefix)) {
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const state = value as ProviderState;
    const authIssue = isRecord(state.authIssue) ? (state.authIssue as Record<string, unknown>) : null;
    const kind = typeof authIssue?.kind === 'string' ? String(authIssue.kind).trim() : '';
    if (kind !== 'google_account_verification') {
      continue;
    }
    providerKeys.push(key);
    const candidateUrl = typeof authIssue?.url === 'string' ? String(authIssue.url).trim() : '';
    if (candidateUrl) {
      url = pickBetterGoogleUrl(url, sanitizeUrl(candidateUrl));
    }
    if (reason === null && typeof state.reason === 'string') {
      const r = String(state.reason).trim();
      reason = r || null;
    }
    if (inPool === null && typeof state.inPool === 'boolean') {
      inPool = state.inPool;
    }
  }

  if (!providerKeys.length) {
    return null;
  }

  if (!url || isHelpOnlyGoogleUrl(url)) {
    const recovered = await findGoogleVerificationUrlFromErrorLog(providerKeys);
    url = pickBetterGoogleUrl(url, recovered);
  }

  providerKeys.sort((a, b) => a.localeCompare(b));
  return { providerKeys, url, inPool, reason };
}
