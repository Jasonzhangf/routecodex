import fs from 'fs';
import { fetchModelsFromUpstream } from './fetch-models.js';
import { getBlacklistPath, getModelsCachePath, getProviderConfigOutputPath, getProviderRootDir } from './paths.js';
import { readBlacklist, writeBlacklist } from './blacklist.js';
import { buildOrUpdateProviderConfig } from './config-builder.js';
import { probeFirstWorkingKey } from './key-probe.js';
import { formatUpdateSummary } from './diff.js';
import type { ProviderInputConfig, UpdateOptions, UpdateResult } from './types.js';

type LegacyProviderConfigNode = {
  providerId?: string;
  id?: string;
  type?: string;
  providerType?: string;
  baseUrl?: string;
  baseURL?: string;
  auth?: ProviderInputConfig['auth'];
  apiKey?: Array<unknown> | string | null;
  model?: string | null;
  models?: Array<unknown>;
};

type OpenAIStandardProviderConfig = {
  type: 'openai-standard';
  config: LegacyProviderConfigNode;
  providerId?: string;
  id?: string;
  [key: string]: unknown;
};

type ProviderConfigFile = LegacyProviderConfigNode | OpenAIStandardProviderConfig;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isLegacyProviderConfig = (value: unknown): value is LegacyProviderConfigNode =>
  isRecord(value);

const isOpenAIStandardConfig = (value: unknown): value is OpenAIStandardProviderConfig =>
  isRecord(value) && value.type === 'openai-standard' && isLegacyProviderConfig(value.config);

const pickFirstString = (...values: Array<unknown>): string | null => {
  for (const value of values) {
    if (value === undefined || value === null) {continue;}
    const str = String(value).trim();
    if (str) {return str;}
  }
  return null;
};

const normalizeStringArray = (values: unknown): string[] | undefined => {
  if (!Array.isArray(values)) {return undefined;}
  const result: string[] = [];
  for (const entry of values) {
    const normalized = pickFirstString(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result.length ? result : undefined;
};

const resolveSeedModels = (config: LegacyProviderConfigNode): string[] => {
  const seeds = new Set<string>();
  const push = (value: unknown): void => {
    const normalized = pickFirstString(value);
    if (normalized) {
      seeds.add(normalized);
    }
  };
  push(config.model);
  if (Array.isArray(config.models)) {
    for (const entry of config.models) {
      push(entry);
    }
  }
  return Array.from(seeds);
};

const ensureLegacyConfig = (config: ProviderConfigFile): LegacyProviderConfigNode =>
  isOpenAIStandardConfig(config) ? config.config : config;

function readJson<T>(file: string): T | null {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function ensureDir(dir: string): void { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }

export async function updateProviderModels(options: UpdateOptions): Promise<UpdateResult> {
  const input = options.configPath;
  if (!input) {throw new Error('--config is required');}

  const rawData = readJson<unknown>(input);
  if (!rawData) {throw new Error('invalid provider config JSON');}

  let raw: ProviderConfigFile;
  if (isOpenAIStandardConfig(rawData)) {
    raw = rawData;
  } else if (isLegacyProviderConfig(rawData)) {
    raw = rawData;
  } else {
    throw new Error('invalid provider config JSON');
  }

  // Support both legacy flat configs and V2 openai-standard provider configs:
  // - Legacy: { providerId, type, baseUrl, auth, apiKey:[] }
  // - V2: { type: 'openai-standard', config: { providerType, baseUrl, auth, apiKey? } }
  const baseNode = ensureLegacyConfig(raw);

  const apiKeyList =
    Array.isArray(baseNode.apiKey)
      ? normalizeStringArray(baseNode.apiKey)
      : (() => {
        const single = pickFirstString(baseNode.apiKey);
        return single ? [single] : undefined;
      })();

  const providerId =
    pickFirstString(
      options.providerId,
      raw.providerId,
      raw.id,
      baseNode.providerId,
      baseNode.id
    ) ?? 'provider';

  const providerType =
    pickFirstString(
      baseNode.providerType,
      baseNode.type,
      raw.type
    ) ?? 'openai';

  const baseUrl = pickFirstString(baseNode.baseUrl, baseNode.baseURL) ?? '';
  const baseURL = pickFirstString(baseNode.baseURL, baseNode.baseUrl) ?? '';

  const provider: ProviderInputConfig = {
    providerId,
    // For openai-standard configs, prefer config.providerType as the logical upstream family (e.g., 'qwen', 'glm')
    type: providerType,
    baseUrl,
    baseURL,
    auth: baseNode.auth,
    apiKey: apiKeyList
  };
  if (!provider.providerId) {throw new Error('providerId missing');}
  if (!provider.baseUrl && !provider.baseURL) {throw new Error('baseUrl/baseURL missing');}

  const rootDir = getProviderRootDir(provider.providerId, options.outputDir);
  const blacklistPath = getBlacklistPath(provider.providerId, options.outputDir, options.blacklistFile);
  const cachePath = getModelsCachePath(provider.providerId, options.outputDir);
  const outputPath = getProviderConfigOutputPath(provider.providerId, options.outputDir);
  ensureDir(rootDir);

  // Load/Update blacklist
  const bl = readBlacklist(blacklistPath);
  const add = options.blacklistAdd || [];
  const rem = options.blacklistRemove || [];
  if (add.length || rem.length) {
    const set = new Set(bl.models);
    for (const m of add) {set.add(m);}
    for (const m of rem) {set.delete(m);}
    bl.models = Array.from(set);
    writeBlacklist(blacklistPath, bl);
  }

  // Fetch models
  let modelsRemote: string[] = [];
  try {
    const r = await fetchModelsFromUpstream(provider, !!options.verbose);
    modelsRemote = r.models || [];
    fs.writeFileSync(cachePath, JSON.stringify(r, null, 2), 'utf-8');
  } catch (e) {
    // Fallback: if provider input declares a model or models list, use it as seed
    const seedModels = resolveSeedModels(baseNode);
    if (seedModels.length > 0) {
      modelsRemote = seedModels;
    } else if (options.useCache) {
      const cached = readJson<{ models?: string[] }>(cachePath);
      if (!cached?.models || !Array.isArray(cached.models)) {throw e;}
      modelsRemote = cached.models;
    } else {
      throw e;
    }
  }

  if (options.listOnly) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ provider: provider.providerId, total: modelsRemote.length, models: modelsRemote }, null, 2));
    return {
      providerId: provider.providerId,
      totalRemote: modelsRemote.length,
      filtered: modelsRemote.length,
      added: [], removed: [], kept: [], completedWithTemplates: [],
      outputPath, blacklistPath
    };
  }

  // Filter with blacklist
  const blacklistSet = new Set(bl.models || []);
  const modelsFiltered = modelsRemote.filter((m) => !blacklistSet.has(m));

  // Build/Update config JSON
  const { config, summary } = buildOrUpdateProviderConfig({ providerId: provider.providerId, provider, modelsFiltered, outputPath });

  // Optional: probe apiKey list and set auth.apiKey to first working key
  if (options.probeKeys) {
    try {
      const provNode = config.virtualrouter.providers?.[provider.providerId];
      const keysInput = Array.isArray(provider.apiKey) ? provider.apiKey : [];
      const keysExisting = provNode && Array.isArray(provNode.apiKey) ? provNode.apiKey : [];
      const candidates = Array.from(new Set([...(keysInput || []), ...(keysExisting || [])])).filter(Boolean);
      if (provNode && candidates.length) {
        const picked = await probeFirstWorkingKey(provider, candidates, !!options.verbose);
        if (picked) {
          provNode.auth = provNode.auth || { type: 'apikey' };
          if (!provNode.auth.type) {provNode.auth.type = 'apikey';}
          provNode.auth.apiKey = picked;
        }
      }
    } catch { /* non-blocking */ }
  }

  // Write output
  if (options.write) {
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf-8');
  } else {
    // eslint-disable-next-line no-console
    console.log('[DRY RUN] Preview config would be written to:', outputPath);
    // eslint-disable-next-line no-console
    console.log(formatUpdateSummary(summary, { verbose: options.verbose }));
  }

  return {
    providerId: provider.providerId,
    totalRemote: modelsRemote.length,
    filtered: modelsFiltered.length,
    added: summary.added,
    removed: summary.removed,
    kept: summary.kept,
    completedWithTemplates: summary.completedWithTemplates,
    outputPath,
    blacklistPath
  };
}
