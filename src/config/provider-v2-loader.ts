import fs from 'node:fs/promises';
import path from 'node:path';
import type { UnknownRecord } from './virtual-router-types.js';
import { resolveRccProviderDir } from './user-data-paths.js';

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

interface ProviderConfigFileEntry {
  fileName: string;
  filePath: string;
  isBaseFile: boolean;
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
  if (rootDir && rootDir.trim().length) {
    const base = path.resolve(rootDir.trim());
    await fs.mkdir(base, { recursive: true });
    return base;
  }
  const primary = resolveRccProviderDir();
  await fs.mkdir(primary, { recursive: true });
  return primary;
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

function isProviderConfigV2FileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized.endsWith('.json')) {
    return false;
  }
  if (!normalized.startsWith('config.v2')) {
    return false;
  }
  if (normalized.includes('.bak.')) {
    return false;
  }
  return normalized === 'config.v2.json' || /^config\.v2\..+\.json$/i.test(normalized);
}

async function listProviderConfigFiles(entry: ProviderDirEntry): Promise<ProviderConfigFileEntry[]> {
  const entries = await fs.readdir(entry.dirPath, { withFileTypes: true });
  const files = entries
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .filter((fileName) => isProviderConfigV2FileName(fileName))
    .sort((a, b) => {
      if (a === 'config.v2.json') return -1;
      if (b === 'config.v2.json') return 1;
      return a.localeCompare(b);
    });
  return files.map((fileName) => ({
    fileName,
    filePath: path.join(entry.dirPath, fileName),
    isBaseFile: fileName === 'config.v2.json'
  }));
}

function resolveProviderIdForConfigFile(
  entry: ProviderDirEntry,
  file: ProviderConfigFileEntry,
  parsed: UnknownRecord,
  providerRecord: UnknownRecord
): string {
  const providerIdRaw = typeof parsed.providerId === 'string' ? parsed.providerId.trim() : '';
  const providerNodeId = typeof providerRecord.id === 'string' ? providerRecord.id.trim() : '';

  if (file.isBaseFile) {
    const providerId = entry.id.trim();
    if (!providerId) {
      throw new Error(`[config] invalid provider directory name for ${file.filePath}`);
    }
    if (providerIdRaw && providerIdRaw !== providerId) {
      throw new Error(
        `[config] providerId mismatch: dir="${providerId}" file="${providerIdRaw}". Use the directory name as the single source of truth for ${file.fileName}.`
      );
    }
    if (providerNodeId && providerNodeId !== providerId) {
      throw new Error(
        `[config] provider.id mismatch: dir="${providerId}" provider.id="${providerNodeId}". Use the directory name as the single source of truth for ${file.fileName}.`
      );
    }
    if (!providerNodeId) {
      providerRecord.id = providerId;
    }
    return providerId;
  }

  const explicitProviderId = providerIdRaw || providerNodeId;
  if (!explicitProviderId) {
    throw new Error(
      `[config] ${file.filePath} must declare providerId or provider.id because suffixed config files are standalone providers.`
    );
  }
  if (providerIdRaw && providerNodeId && providerIdRaw !== providerNodeId) {
    throw new Error(
      `[config] providerId/provider.id mismatch in ${file.filePath}: providerId="${providerIdRaw}" provider.id="${providerNodeId}".`
    );
  }
  if (!providerNodeId) {
    providerRecord.id = explicitProviderId;
  }
  return explicitProviderId;
}

async function loadProviderConfigV2(
  entry: ProviderDirEntry,
  file: ProviderConfigFileEntry
): Promise<ProviderConfigV2 | null> {
  const parsed = await readJsonFile(file.filePath);
  if (!parsed) {
    return null;
  }

  const providerNode = (parsed as { provider?: unknown }).provider;

  if (!providerNode || typeof providerNode !== 'object' || Array.isArray(providerNode)) {
    return null;
  }

  const providerRecord = providerNode as UnknownRecord;
  const providerId = resolveProviderIdForConfigFile(entry, file, parsed, providerRecord);

  const versionRaw = (parsed as { version?: unknown }).version;
  const version =
    typeof versionRaw === 'string' && versionRaw.trim().length ? versionRaw : '2.0.0';

  return {
    version,
    providerId,
    provider: providerRecord
  };
}

/**
 * Load all Provider v2 configs under the given root directory.
 *
 * Rules:
 * - `config.v2.json` uses the directory name as the single source of truth.
 * - `config.v2.*.json` files are treated as standalone provider declarations
 *   and must declare a globally unique provider id.
 */
export async function loadProviderConfigsV2(rootDir?: string): Promise<Record<string, ProviderConfigV2>> {
  const root = await ensureProviderRoot(rootDir);
  const dirs = await listProviderDirs(root);
  const result: Record<string, ProviderConfigV2> = {};
  for (const entry of dirs) {
    const files = await listProviderConfigFiles(entry);
    for (const file of files) {
      const cfg = await loadProviderConfigV2(entry, file);
      if (!cfg) {
        continue;
      }
      if (result[cfg.providerId]) {
        throw new Error(
          `[config] duplicate providerId "${cfg.providerId}" loaded from ${file.filePath}. Provider ids must be globally unique.`
        );
      }
      result[cfg.providerId] = cfg;
    }
  }
  return result;
}
