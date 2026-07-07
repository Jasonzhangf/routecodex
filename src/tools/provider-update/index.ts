import fs from 'fs';
import path from 'path';
import { fetchModelsFromUpstream } from './fetch-models.js';
import { readBlacklist, writeBlacklist } from './blacklist.js';
import { probeFirstWorkingKey } from './key-probe.js';
import { formatUpdateSummary } from './diff.js';
import type { ProviderInputConfig, UpdateOptions, UpdateResult } from './types.js';
import { writeProviderConfigFile } from '../../config/provider-config-writer.js';
import { loadProviderConfigsV2, type ProviderConfigV2 } from '../../config/provider-v2-loader.js';
import { resolveRccProviderDir } from '../../config/user-data-paths.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const pickFirstString = (...values: Array<unknown>): string | null => {
  for (const value of values) {
    if (value === undefined || value === null) {continue;}
    const str = String(value).trim();
    if (str) {return str;}
  }
  return null;
};

const normalizeStringArray = (values: unknown): string[] => {
  if (!Array.isArray(values)) {return [];}
  const result: string[] = [];
  for (const entry of values) {
    const normalized = pickFirstString(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
};

function normalizeModelsNode(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [modelId, modelConfig] of Object.entries(value)) {
    out[modelId] = isRecord(modelConfig) ? { ...modelConfig } : {};
  }
  return out;
}

function readModelsCache(file: string): string[] {
  const cached = JSON.parse(fs.readFileSync(file, 'utf-8')) as { models?: unknown };
  if (!Array.isArray(cached.models)) {
    throw new Error(`models cache missing array: ${file}`);
  }
  return cached.models.map((model) => String(model));
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveProviderNode(parsed: ProviderConfigV2): Record<string, unknown> {
  if (!isRecord(parsed.provider)) {
    throw new Error('invalid provider config TOML: provider table is required');
  }
  return parsed.provider;
}

function buildProviderInput(providerId: string, providerNode: Record<string, unknown>): ProviderInputConfig {
  const providerType =
    pickFirstString(
      providerNode.providerType,
      providerNode.type
    ) ?? 'openai';
  const baseUrl = pickFirstString(providerNode.baseUrl, providerNode.baseURL) ?? '';
  const baseURL = pickFirstString(providerNode.baseURL, providerNode.baseUrl) ?? '';
  const auth = isRecord(providerNode.auth) ? providerNode.auth as ProviderInputConfig['auth'] : undefined;
  const authApiKey = auth && typeof auth.apiKey === 'string' ? auth.apiKey : null;
  const apiKey = [
    ...normalizeStringArray(providerNode.apiKey),
    ...(authApiKey ? [authApiKey] : [])
  ];
  if (!baseUrl && !baseURL) {
    throw new Error('baseUrl/baseURL missing in provider config.v2.toml');
  }
  return {
    providerId,
    type: providerType,
    baseUrl,
    baseURL,
    auth,
    apiKey: Array.from(new Set(apiKey))
  };
}

export async function updateProviderModels(options: UpdateOptions): Promise<UpdateResult> {
  const providerId = pickFirstString(options.providerId);
  if (!providerId) {
    throw new Error('providerId is required');
  }
  const providerRoot = options.rootDir && options.rootDir.trim()
    ? path.resolve(options.rootDir.trim())
    : resolveRccProviderDir();
  const parsed = (await loadProviderConfigsV2(providerRoot))[providerId];
  if (!parsed) {
    throw new Error(`No provider config.v2.toml found for provider "${providerId}" under ${providerRoot}`);
  }
  const providerNode = resolveProviderNode(parsed);
  if (!providerNode.id) {
    providerNode.id = providerId;
  }
  parsed.providerId = providerId;

  const provider = buildProviderInput(providerId, providerNode);

  const providerDir = path.join(providerRoot, provider.providerId);
  const blacklistPath = options.blacklistFile && options.blacklistFile.trim()
    ? path.resolve(options.blacklistFile.trim())
    : path.join(providerDir, 'blacklist.json');
  const cachePath = path.join(providerDir, 'models-latest.json');
  const outputPath = path.join(providerDir, 'config.v2.toml');
  ensureDir(providerDir);

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
    if (options.useCache) {
      modelsRemote = readModelsCache(cachePath);
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

  const currentModels = normalizeModelsNode(providerNode.models);
  const currentSet = new Set(Object.keys(currentModels));
  const nextSet = new Set(modelsFiltered);
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const nextModels: Record<string, Record<string, unknown>> = {};
  for (const modelId of modelsFiltered) {
    if (currentSet.has(modelId)) {
      kept.push(modelId);
      nextModels[modelId] = currentModels[modelId] ?? {};
    } else {
      added.push(modelId);
      nextModels[modelId] = {};
    }
  }
  for (const modelId of currentSet) {
    if (!nextSet.has(modelId)) {
      removed.push(modelId);
    }
  }
  providerNode.models = nextModels;
  const summary = { added, removed, kept, completedWithTemplates: [] as string[] };

  // Optional: probe apiKey list and set auth.apiKey to first working key
  if (options.probeKeys) {
    const keysInput = Array.isArray(provider.apiKey) ? provider.apiKey : [];
    const keysExisting = normalizeStringArray(providerNode.apiKey);
    const candidates = Array.from(new Set([...(keysInput || []), ...(keysExisting || [])])).filter(Boolean);
    if (candidates.length) {
      const picked = await probeFirstWorkingKey(provider, candidates, !!options.verbose);
      if (picked) {
        const auth = isRecord(providerNode.auth) ? providerNode.auth : { type: 'apikey' };
        if (!auth.type) {auth.type = 'apikey';}
        auth.apiKey = picked;
        providerNode.auth = auth;
      }
    }
  }

  // Write output
  if (options.write) {
    await writeProviderConfigFile(outputPath, parsed as unknown as Record<string, unknown>);
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
