import fs from 'fs';
import type { ProviderInputConfig } from './types.js';

type ModelConfig = Record<string, unknown>;

interface ProviderNode {
  id: string;
  enabled: boolean;
  type: string;
  baseURL?: string;
  auth?: ProviderInputConfig['auth'];
  apiKey?: string[];
  models: Record<string, ModelConfig>;
}

interface VirtualRouterBlock {
  outputProtocol: string;
  providers: Record<string, ProviderNode>;
  routing: { default: string[] };
}

interface ProviderConfigFile {
  version: string;
  httpserver?: {
    port: number;
    host: string;
  };
  virtualrouter: VirtualRouterBlock;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function readJson(file: string): ProviderConfigFile | null {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (isRecord(parsed) && isRecord(parsed.virtualrouter) && isRecord(parsed.virtualrouter.providers)) {
        return parsed as ProviderConfigFile;
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

function ensureProviderSkeleton(providerId: string, provider: ProviderInputConfig): ProviderConfigFile {
  const baseUrl = provider.baseUrl || provider.baseURL || '';
  const auth = provider.auth;
  return {
    version: '1.0.0',
    httpserver: {
      port: 5521,
      host: '127.0.0.1'
    },
    virtualrouter: {
      outputProtocol: 'openai',
      providers: {
        [providerId]: {
          id: providerId,
          enabled: true,
          type: provider.type || 'openai',
          baseURL: baseUrl,
          ...(auth ? { auth } : {}),
          ...(Array.isArray(provider.apiKey) ? { apiKey: provider.apiKey } : {}),
          models: {}
        }
      },
      routing: {
        default: []
      }
    }
  };
}

export type BuildConfigArgs = {
  providerId: string;
  provider: ProviderInputConfig;
  modelsFiltered: string[];
  outputPath: string;
};

export function buildOrUpdateProviderConfig(args: BuildConfigArgs): { config: ProviderConfigFile; summary: { added: string[]; removed: string[]; kept: string[]; completedWithTemplates: string[] } } {
  const { providerId, provider, modelsFiltered, outputPath } = args;
  const existing = readJson(outputPath) || ensureProviderSkeleton(providerId, provider);
  const providers = existing.virtualrouter.providers ?? {};
  existing.virtualrouter.providers = providers;
  const provNode = providers[providerId] || ensureProviderSkeleton(providerId, provider).virtualrouter.providers[providerId];
  providers[providerId] = provNode;
  const currentModels: Record<string, ModelConfig> = provNode.models || {};

  const currentSet = new Set(Object.keys(currentModels));
  const nextSet = new Set(modelsFiltered);
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const templated: string[] = [];

  // Remove blacklisted (not present) models
  for (const m of Array.from(currentSet)) {
    if (!nextSet.has(m)) {
      delete currentModels[m];
      removed.push(m);
    }
  }
  // Add or merge models with templates
  for (const m of modelsFiltered) {
    if (!currentModels[m]) {
      added.push(m);
      currentModels[m] = {};
    } else {
      kept.push(m);
    }
  }

  provNode.models = currentModels;

  // Ensure baseURL/auth are present from provider input (do not overwrite existing explicit non-empty values)
  const baseUrl = provider.baseUrl || provider.baseURL || '';
  if (baseUrl && !provNode.baseURL) {
    provNode.baseURL = baseUrl;
  }
  if (provider.auth && !provNode.auth) {
    provNode.auth = provider.auth;
  }
  // Preserve or set apiKey list; do not overwrite existing non-empty list
  if (Array.isArray(provider.apiKey)) {
    const existingList: string[] = Array.isArray(provNode.apiKey) ? provNode.apiKey : [];
    const next = Array.from(new Set([...(existingList || []), ...provider.apiKey])).filter(Boolean);
    if (next.length) {
      provNode.apiKey = next;
    }
    // Ensure auth.apiKey defaults to first key if not set
    if ((!provNode.auth || !provNode.auth.apiKey) && next.length) {
      provNode.auth = provNode.auth || { type: 'apikey' };
      if (!provNode.auth.type) {
        provNode.auth.type = 'apikey';
      }
      provNode.auth.apiKey = next[0];
    }
  }

  // Set default routing if empty
  // 不再自动回填 routing.default；由使用者提供完整路由。
  // 如果 routing.default 丢失，保留为空数组，交由 CLI/用户补全。

  return { config: existing, summary: { added, removed, kept, completedWithTemplates: templated } };
}
