import fs from 'fs';
import path from 'path';
import { fetchModelsFromUpstream } from './fetch-models.js';
import { getBlacklistPath, getModelsCachePath, getProviderConfigOutputPath, getProviderRootDir } from './paths.js';
import { readBlacklist, writeBlacklist } from './blacklist.js';
import { buildOrUpdateProviderConfig } from './config-builder.js';
import { probeFirstWorkingKey } from './key-probe.js';
import { formatUpdateSummary } from './diff.js';
import type { ProviderInputConfig, UpdateOptions, UpdateResult } from './types.js';

function readJson(file: string): any | null {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* ignore */ }
  return null;
}

function ensureDir(dir: string): void { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }

export async function updateProviderModels(options: UpdateOptions): Promise<UpdateResult> {
  const input = options.configPath;
  if (!input) throw new Error('--config is required');
  const raw = readJson(input);
  if (!raw || typeof raw !== 'object') throw new Error('invalid provider config JSON');
  // Support both legacy flat configs and V2 openai-standard provider configs:
  // - Legacy: { providerId, type, baseUrl, auth, apiKey:[] }
  // - V2: { type: 'openai-standard', config: { providerType, baseUrl, auth, apiKey? } }
  const openaiStdConfig = (raw as any).type === 'openai-standard' && (raw as any).config && typeof (raw as any).config === 'object'
    ? (raw as any).config
    : null;
  const baseNode: any = openaiStdConfig || raw;

  const apiKeyList = Array.isArray(baseNode.apiKey)
    ? (baseNode.apiKey as any[]).map((x)=>String(x))
    : undefined;
  const provider: ProviderInputConfig = {
    providerId: options.providerId || String(baseNode.providerId || baseNode.id || (raw as any).providerId || (raw as any).id || 'provider').trim(),
    // For openai-standard configs, prefer config.providerType as the logical upstream family (e.g., 'qwen', 'glm')
    type: String(baseNode.providerType || baseNode.type || (raw as any).type || 'openai'),
    baseUrl: String(baseNode.baseUrl || baseNode.baseURL || ''),
    baseURL: String(baseNode.baseURL || baseNode.baseUrl || ''),
    auth: baseNode.auth,
    apiKey: apiKeyList
  };
  if (!provider.providerId) throw new Error('providerId missing');
  if (!provider.baseUrl && !provider.baseURL) throw new Error('baseUrl/baseURL missing');

  const rootDir = getProviderRootDir(provider.providerId, options.outputDir);
  const blacklistPath = getBlacklistPath(provider.providerId, options.outputDir, options.blacklistFile);
  const cachePath = getModelsCachePath(provider.providerId, options.outputDir);
  const outputPath = getProviderConfigOutputPath(provider.providerId, options.outputDir);
  ensureDir(rootDir);

  // Load/Update blacklist
  let bl = readBlacklist(blacklistPath);
  const add = options.blacklistAdd || [];
  const rem = options.blacklistRemove || [];
  if (add.length || rem.length) {
    const set = new Set(bl.models);
    for (const m of add) set.add(m);
    for (const m of rem) set.delete(m);
    bl.models = Array.from(set);
    writeBlacklist(blacklistPath, bl);
  }

  // Fetch models
  let modelsRemote: string[] = [];
  let rawRemote: unknown = undefined;
  try {
    const r = await fetchModelsFromUpstream(provider, !!options.verbose);
    modelsRemote = r.models || [];
    rawRemote = r.raw;
    fs.writeFileSync(cachePath, JSON.stringify(r, null, 2), 'utf-8');
  } catch (e) {
    // Fallback: if provider input declares a model or models list, use it as seed
    const seedModels: string[] = (() => {
      try {
        if (typeof raw?.model === 'string' && raw.model.trim()) return [String(raw.model).trim()];
      } catch { /* ignore */ }
      try {
        if (Array.isArray(raw?.models)) return (raw.models as any[]).map((x)=>String(x)).filter(Boolean);
      } catch { /* ignore */ }
      // 支持 openai-standard 配置：从 config.model / config.models 读取种子模型
      try {
        const cfg: any = (raw as any)?.config;
        if (cfg) {
          if (typeof cfg.model === 'string' && cfg.model.trim()) {
            return [String(cfg.model).trim()];
          }
          if (Array.isArray(cfg.models)) {
            return (cfg.models as any[]).map((x)=>String(x)).filter(Boolean);
          }
        }
      } catch { /* ignore */ }
      return [];
    })();
    if (seedModels.length > 0) {
      modelsRemote = seedModels;
      rawRemote = { seeded: true };
    } else if (options.useCache) {
      const cached = readJson(cachePath);
      if (!cached?.models) throw e;
      modelsRemote = Array.isArray(cached.models) ? cached.models : [];
      rawRemote = cached.raw;
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
      const provNode = (config?.virtualrouter?.providers || {})[provider.providerId];
      const keysInput: string[] = Array.isArray(provider.apiKey) ? provider.apiKey as string[] : [];
      const keysExisting: string[] = Array.isArray(provNode?.apiKey) ? provNode.apiKey as string[] : [];
      const candidates = Array.from(new Set([...(keysInput || []), ...(keysExisting || [])])).filter(Boolean);
      if (candidates.length) {
        const picked = await probeFirstWorkingKey(provider, candidates, !!options.verbose);
        if (picked) {
          provNode.auth = provNode.auth || { type: 'apikey' };
          if (!provNode.auth.type) provNode.auth.type = 'apikey';
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
