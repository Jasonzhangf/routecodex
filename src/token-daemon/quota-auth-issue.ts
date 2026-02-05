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

function resolveQuotaManagerPath(): string {
  return path.join(os.homedir(), '.routecodex', 'quota', 'quota-manager.json');
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
    if (!url && candidateUrl) {
      url = candidateUrl;
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

  providerKeys.sort((a, b) => a.localeCompare(b));
  return { providerKeys, url, inPool, reason };
}

