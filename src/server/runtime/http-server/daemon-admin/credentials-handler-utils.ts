import path from 'node:path';
import fs from 'node:fs/promises';
import { collectTokenSnapshot, resolveAuthDir } from '../../../../token-daemon/token-utils.js';

export interface CredentialSummary {
  id: string;
  kind: 'oauth' | 'apikey';
  provider: string;
  alias: string;
  tokenFile: string;
  displayName: string;
  expiresAt: number | null;
  expiresInSec: number | null;
  status: string;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  hasApiKey: boolean;
  noRefresh: boolean;
  secretRef?: string;
}

type ApiKeyMatch = {
  filePath: string;
  providerPrefix: string;
  sequence: number;
  alias: string;
  id: string;
  hasApiKey: boolean;
};

const APIKEY_FILE_PATTERN = /^(.+)-apikey-(\d+)(?:-(.+))?\.key$/i;

export const SUPPORTED_OAUTH_PROVIDERS = new Set(['iflow', 'qwen', 'gemini-cli', 'antigravity']);

export async function buildCredentialSummaries(): Promise<CredentialSummary[]> {
  const snapshot = await collectTokenSnapshot();
  const results: CredentialSummary[] = [];
  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const id = path.basename(token.filePath).replace(/\.json$/i, '');
      const expiresAt = token.state.expiresAt;
      const expiresInSec =
        token.state.msUntilExpiry !== null && token.state.msUntilExpiry !== undefined
          ? Math.round(token.state.msUntilExpiry / 1000)
          : null;
      const kind: CredentialSummary['kind'] =
        token.state.hasAccessToken || token.state.hasRefreshToken ? 'oauth' : 'apikey';
      results.push({
        id,
        kind,
        provider: providerSnapshot.provider,
        alias: token.alias,
        tokenFile: token.filePath,
        displayName: token.displayName,
        expiresAt,
        expiresInSec,
        status: token.state.status,
        hasRefreshToken: token.state.hasRefreshToken,
        hasAccessToken: token.state.hasAccessToken,
        hasApiKey: token.state.hasApiKey,
        noRefresh: token.state.noRefresh === true
      });
    }
  }

  const apikeyMatches = await scanApiKeyAuthFiles();
  for (const match of apikeyMatches) {
    const hasApiKey = Boolean(match.hasApiKey);
    results.push({
      id: match.id,
      kind: 'apikey',
      provider: match.providerPrefix,
      alias: match.alias,
      tokenFile: match.filePath,
      displayName: match.alias && match.alias !== 'default' ? match.alias : match.id,
      expiresAt: null,
      expiresInSec: null,
      status: hasApiKey ? 'valid' : 'invalid',
      hasRefreshToken: false,
      hasAccessToken: false,
      hasApiKey,
      noRefresh: true,
      secretRef: `authfile-${path.basename(match.filePath)}`
    });
  }
  return results;
}

async function scanApiKeyAuthFiles(): Promise<ApiKeyMatch[]> {
  try {
    const authDir = resolveAuthDir();
    const entries = await fs.readdir(authDir);
    const matches: ApiKeyMatch[] = [];
    for (const entry of entries) {
      const m = entry.match(APIKEY_FILE_PATTERN);
      if (!m) {
        continue;
      }
      const providerPrefix = m[1] || '';
      const sequence = parseInt(m[2], 10);
      const alias = (m[3] || 'default').trim() || 'default';
      if (!providerPrefix || !Number.isFinite(sequence) || sequence <= 0) {
        continue;
      }
      const filePath = path.join(authDir, entry);
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      const hasApiKey = Boolean(content && content.trim());
      matches.push({
        filePath,
        providerPrefix,
        sequence,
        alias,
        id: path.basename(entry, '.key'),
        hasApiKey
      });
    }
    matches.sort((a, b) => a.sequence - b.sequence);
    return matches;
  } catch {
    return [];
  }
}

export async function allocateApiKeyFileName(provider: string, alias: string): Promise<string> {
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const safeAlias = alias.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const entries = await scanApiKeyAuthFiles();
  let maxSeq = 0;
  for (const entry of entries) {
    if (entry.providerPrefix.toLowerCase() !== safeProvider) {
      continue;
    }
    if (entry.sequence > maxSeq) {
      maxSeq = entry.sequence;
    }
  }
  const nextSeq = maxSeq + 1;
  return `${safeProvider}-apikey-${nextSeq}-${safeAlias}.key`;
}
