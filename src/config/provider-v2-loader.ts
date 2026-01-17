import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { UnknownRecord } from './virtual-router-types.js';

export interface ProviderConfigV2 {
  version: string;
  providerId: string;
  /**
   * Provider configuration payload compatible with the `providers[providerId]`
   * entry expected by `bootstrapVirtualRouterConfig`.
   */
  provider: UnknownRecord;
}

interface ProviderDirEntry {
  id: string;
  dirPath: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureProviderRoot(rootDir?: string): Promise<string> {
  const base =
    rootDir && rootDir.trim().length
      ? path.resolve(rootDir.trim())
      : path.join(os.homedir(), '.routecodex', 'provider');
  await fs.mkdir(base, { recursive: true });
  return base;
}

async function listProviderDirs(rootDir: string): Promise<ProviderDirEntry[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs: ProviderDirEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === '.DS_Store') {
      continue;
    }
    const id = entry.name;
    const dirPath = path.join(rootDir, id);
    dirs.push({ id, dirPath });
  }
  return dirs;
}

async function readJsonFile(filePath: string): Promise<UnknownRecord | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UnknownRecord) : {};
  } catch {
    return null;
  }
}

async function loadProviderConfigV2(entry: ProviderDirEntry): Promise<ProviderConfigV2 | null> {
  const v2Path = path.join(entry.dirPath, 'config.v2.json');
  if (!(await pathExists(v2Path))) {
    return null;
  }

  const parsed = await readJsonFile(v2Path);
  if (!parsed) {
    return null;
  }

  const providerIdRaw = (parsed as { providerId?: unknown }).providerId;
  const providerNode = (parsed as { provider?: unknown }).provider;

  if (typeof providerIdRaw !== 'string' || !providerIdRaw.trim() || !providerNode || typeof providerNode !== 'object' || Array.isArray(providerNode)) {
    return null;
  }

  const versionRaw = (parsed as { version?: unknown }).version;
  const version =
    typeof versionRaw === 'string' && versionRaw.trim().length ? versionRaw : '2.0.0';

  return {
    version,
    providerId: providerIdRaw.trim(),
    provider: providerNode as UnknownRecord
  };
}

/**
 * Load all Provider v2 configs under the given root directory.
 * If a provider directory lacks `config.v2.json` but contains a v1-style
 * config, an initial `config.v2.json` will be generated based on it.
 */
export async function loadProviderConfigsV2(rootDir?: string): Promise<Record<string, ProviderConfigV2>> {
  const root = await ensureProviderRoot(rootDir);
  const dirs = await listProviderDirs(root);
  const result: Record<string, ProviderConfigV2> = {};
  for (const entry of dirs) {
    const cfg = await loadProviderConfigV2(entry);
    if (!cfg) {
      continue;
    }
    result[cfg.providerId] = cfg;
  }
  return result;
}
