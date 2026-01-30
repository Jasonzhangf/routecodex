import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type AntigravityReauthRequiredRecord = {
  provider: 'antigravity' | 'gemini-cli';
  alias: string;
  tokenFile?: string;
  profileId?: string;
  fromSuffix?: string;
  toSuffix?: string;
  updatedAt: number;
};

function getStateFilePath(): string {
  const home = (process.env.HOME || '').trim() || os.homedir();
  return path.join(home, '.routecodex', 'state', 'antigravity-reauth-required.json');
}

function normalizeAlias(alias: string): string {
  return typeof alias === 'string' ? alias.trim().toLowerCase() : '';
}

export async function readAntigravityReauthRequiredState(): Promise<Record<string, AntigravityReauthRequiredRecord>> {
  const stateFile = getStateFilePath();
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, AntigravityReauthRequiredRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key.trim()) {
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const provider = record.provider === 'gemini-cli' ? 'gemini-cli' : 'antigravity';
      const alias = normalizeAlias(typeof record.alias === 'string' ? record.alias : key);
      if (!alias) {
        continue;
      }
      const updatedAtRaw = record.updatedAt;
      const updatedAt = typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
        ? Math.floor(updatedAtRaw)
        : 0;
      if (!updatedAt) {
        continue;
      }
      out[alias] = {
        provider,
        alias,
        tokenFile: typeof record.tokenFile === 'string' ? record.tokenFile : undefined,
        profileId: typeof record.profileId === 'string' ? record.profileId : undefined,
        fromSuffix: typeof record.fromSuffix === 'string' ? record.fromSuffix : undefined,
        toSuffix: typeof record.toSuffix === 'string' ? record.toSuffix : undefined,
        updatedAt
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function writeAntigravityReauthRequiredState(state: Record<string, AntigravityReauthRequiredRecord>): Promise<void> {
  const stateFile = getStateFilePath();
  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

export async function markAntigravityReauthRequired(record: Omit<AntigravityReauthRequiredRecord, 'updatedAt'>): Promise<void> {
  const alias = normalizeAlias(record.alias);
  if (!alias) {
    return;
  }
  const current = await readAntigravityReauthRequiredState();
  current[alias] = {
    provider: record.provider,
    alias,
    tokenFile: record.tokenFile,
    profileId: record.profileId,
    fromSuffix: record.fromSuffix,
    toSuffix: record.toSuffix,
    updatedAt: Date.now()
  };
  await writeAntigravityReauthRequiredState(current);
}

export async function clearAntigravityReauthRequired(alias: string): Promise<void> {
  const key = normalizeAlias(alias);
  if (!key) {
    return;
  }
  const current = await readAntigravityReauthRequiredState();
  if (!(key in current)) {
    return;
  }
  delete current[key];
  await writeAntigravityReauthRequiredState(current);
}

export async function getAntigravityReauthRequiredRecord(alias: string): Promise<AntigravityReauthRequiredRecord | null> {
  const key = normalizeAlias(alias);
  if (!key) {
    return null;
  }
  const current = await readAntigravityReauthRequiredState();
  return current[key] ?? null;
}
