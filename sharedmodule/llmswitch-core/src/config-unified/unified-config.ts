// Unified configuration facade (minimal, focused on context budget for Phase 1)

import fs from 'fs';
import path from 'path';
import { resolveHostPaths } from './enhanced-path-resolver.js';

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type ProviderModels = Record<string, { maxContext?: unknown }>;
type ProviderEntry = { models?: ProviderModels } & UnknownRecord;
const hasProviders = (value: unknown): value is { providers: Record<string, ProviderEntry> } =>
  isRecord(value) && typeof value.providers === 'object' && value.providers !== null;

const logUnifiedConfigNonBlocking = (
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void => {
  try {
    const reason = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error);
    const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[unified-config] ${stage} failed (non-blocking): ${reason}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
};

const readJsonSync = (file: string): UnknownRecord | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as UnknownRecord;
  } catch {
    return null;
  }
};

const listMergedConfigs = (configDir: string): string[] => {
  try {
    const files = fs
      .readdirSync(configDir)
      .filter((name) => /merged-config.*\.json$/i.test(name))
      .map((name) => path.join(configDir, name));
    files.sort((a, b) => {
      try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        return (sb.mtimeMs || 0) - (sa.mtimeMs || 0);
      } catch {
        return 0;
      }
    });
    return files;
  } catch {
    return [];
  }
};

const toNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const extractProviders = (cfg: UnknownRecord): Record<string, ProviderEntry> | null => {
  if (!isRecord(cfg.virtualrouter) || !hasProviders(cfg.virtualrouter)) {
    return null;
  }
  return cfg.virtualrouter.providers ?? null;
};

const extractModulesConfig = (modulesRoot: UnknownRecord): UnknownRecord | null => {
  if (!isRecord(modulesRoot.modules)) {
    return null;
  }
  const virtualRouterModule = modulesRoot.modules.virtualrouter;
  if (!isRecord(virtualRouterModule)) {
    return null;
  }
  const config = virtualRouterModule.config;
  return isRecord(config) ? config : null;
};

const readContextBudgetNode = (configNode: UnknownRecord | null | undefined): { defaultBytes: number | null; safetyRatio: number | null } => {
  if (!configNode) {
    return { defaultBytes: null, safetyRatio: null };
  }
  const contextBudgetNode = configNode.contextBudget;
  if (!isRecord(contextBudgetNode)) {
    return { defaultBytes: null, safetyRatio: null };
  }
  const defaultBytes = toNumber(contextBudgetNode.defaultMaxContextBytes ?? contextBudgetNode.defaultMaxContext);
  const safetyRatio = toNumber(contextBudgetNode.safetyRatio);
  return { defaultBytes, safetyRatio };
};

function findMaxContextInConfig(cfg: UnknownRecord, modelId: string): number | null {
  const providers = extractProviders(cfg);
  if (!providers) {
    return null;
  }
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider.models)) {
      continue;
    }
    const models = provider.models as ProviderModels;
    if (!Object.prototype.hasOwnProperty.call(models, modelId)) {
      continue;
    }
    const target = models[modelId];
    if (!target) {
      continue;
    }
    const maxContext = toNumber(target.maxContext);
    if (maxContext && maxContext > 0) {
      return maxContext;
    }
  }
  return null;
}

export interface ContextBudget {
  maxBytes: number;
  safetyRatio: number; // 0..1
  allowedBytes: number; // floor(maxBytes * (1 - safetyRatio))
  source: string;
}

export class UnifiedConfigFacade {
  private static _instance: UnifiedConfigFacade | null = null;
  static getInstance(): UnifiedConfigFacade {
    if (!this._instance) {
      this._instance = new UnifiedConfigFacade();
    }
    return this._instance;
  }

  private watchers: Array<(ev: { file: string; event: string }) => void> = [];
  private fsWatcher: fs.FSWatcher | null = null;

  // Phase 1: only context budget API
  getContextBudgetForModel(modelId: string): ContextBudget {
    const envDirect = Number(process.env.ROUTECODEX_CONTEXT_BUDGET_BYTES || process.env.RCC_CONTEXT_BUDGET_BYTES || '');
    const envSafety = Number(process.env.RCC_CONTEXT_BUDGET_SAFETY || 'NaN');
    const safetyFromEnv = (Number.isFinite(envSafety) && envSafety >= 0 && envSafety < 1) ? envSafety : NaN;

    if (Number.isFinite(envDirect) && envDirect > 0) {
      const safety = Number.isFinite(safetyFromEnv) ? safetyFromEnv : 0.1;
      return { maxBytes: envDirect, safetyRatio: safety, allowedBytes: Math.floor(envDirect * (1 - safety)), source: 'env' };
    }

    const { configDir } = resolveHostPaths();

    // modules.json defaults
    let modulesDefault: number | null = null;
    let modulesSafety: number | null = null;
    try {
      const modules = readJsonSync(path.join(configDir, 'modules.json'));
      if (modules) {
        const modulesConfig = extractModulesConfig(modules);
        const { defaultBytes, safetyRatio } = readContextBudgetNode(modulesConfig);
        if (defaultBytes && defaultBytes > 0) {
          modulesDefault = defaultBytes;
        }
        if (typeof safetyRatio === 'number' && safetyRatio >= 0 && safetyRatio < 1) {
          modulesSafety = safetyRatio;
        }
      }
    } catch (error) {
      logUnifiedConfigNonBlocking('context_budget.read_modules_json', error, {
        configDir,
        modelId
      });
    }

    // merged-config*.json
    try {
      const merged = listMergedConfigs(configDir);
      for (const f of merged) {
        const cfg = readJsonSync(f);
        if (!cfg) {
          continue;
        }
        const v = findMaxContextInConfig(cfg, modelId);
        if (v && v > 0) {
          const safety = Number.isFinite(safetyFromEnv) ? safetyFromEnv : (modulesSafety ?? 0.1);
          return { maxBytes: v, safetyRatio: safety, allowedBytes: Math.floor(v * (1 - safety)), source: `merged:${path.basename(f)}` };
        }
      }
    } catch (error) {
      logUnifiedConfigNonBlocking('context_budget.scan_merged_configs', error, {
        configDir,
        modelId
      });
    }

    // config.json
    try {
      const cfg = readJsonSync(path.join(configDir, 'config.json'));
      if (cfg) {
        const v = findMaxContextInConfig(cfg, modelId);
        if (v && v > 0) {
          const safety = Number.isFinite(safetyFromEnv) ? safetyFromEnv : (modulesSafety ?? 0.1);
          return { maxBytes: v, safetyRatio: safety, allowedBytes: Math.floor(v * (1 - safety)), source: 'config.json' };
        }
      }
    } catch (error) {
      logUnifiedConfigNonBlocking('context_budget.read_config_json', error, {
        configDir,
        modelId
      });
    }

    // fallback
    const def = modulesDefault && modulesDefault > 0 ? modulesDefault : 200_000;
    const safety = Number.isFinite(safetyFromEnv) ? safetyFromEnv : (modulesSafety ?? 0.1);
    return { maxBytes: def, safetyRatio: safety, allowedBytes: Math.floor(def * (1 - safety)), source: (modulesDefault ? 'modules.json' : 'default') };
  }

  // Minimal schema check for contextBudget fields in modules.json (Phase 1 scope)
  validateConfig(): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    try {
      const { configDir } = resolveHostPaths();
      const modules = readJsonSync(path.join(configDir, 'modules.json'));
      if (modules) {
        const modulesConfig = extractModulesConfig(modules);
        if (modulesConfig && isRecord(modulesConfig.contextBudget)) {
          const contextBudget = modulesConfig.contextBudget;
          const defaultBytes = toNumber(contextBudget.defaultMaxContextBytes ?? contextBudget.defaultMaxContext);
          const safetyRatio = toNumber(contextBudget.safetyRatio);
          if (!(defaultBytes && defaultBytes > 0)) {
            issues.push('contextBudget.defaultMaxContextBytes must be positive number');
          }
          if (!(typeof safetyRatio === 'number' && safetyRatio >= 0 && safetyRatio < 1)) {
            issues.push('contextBudget.safetyRatio must be in [0,1)');
          }
        }
      }
    } catch (error) {
      const err = error as { message?: string };
      issues.push(`validateConfig error: ${err?.message ?? String(error)}`);
    }
    return { ok: issues.length === 0, issues };
  }

  watchConfig(cb: (ev: { file: string; event: string }) => void): void {
    this.watchers.push(cb);
    if (this.fsWatcher) {
      return;
    }
    try {
      const { configDir } = resolveHostPaths();
      this.fsWatcher = fs.watch(configDir, { persistent: false }, (event, file) => {
        try {
          this.watchers.forEach((fn) => fn({ file: file || '', event }));
        } catch (error) {
          logUnifiedConfigNonBlocking('watch_config.notify_callback', error, {
            file: file || '',
            event
          });
        }
      });
    } catch (error) {
      logUnifiedConfigNonBlocking('watch_config.open_fs_watch', error);
    }
  }

  unwatchConfig(cb?: (ev: { file: string; event: string }) => void): void {
    if (!cb) {
      this.watchers = [];
    } else {
      this.watchers = this.watchers.filter((fn) => fn !== cb);
    }
    if (this.watchers.length === 0 && this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch (error) {
        logUnifiedConfigNonBlocking('unwatch_config.close_fs_watch', error);
      }
      this.fsWatcher = null;
    }
  }
}

export const UnifiedConfig = UnifiedConfigFacade.getInstance();
