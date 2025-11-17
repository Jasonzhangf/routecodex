import fs from 'fs';
import path from 'path';
import type { ProviderInputConfig } from './types.js';
import { applyTemplates } from './templates.js';

type JsonObject = Record<string, any>;

function readJson(file: string): JsonObject | null {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* ignore */ }
  return null;
}

function ensureProviderSkeleton(providerId: string, provider: ProviderInputConfig): JsonObject {
  const baseUrl = provider.baseUrl || provider.baseURL || '';
  const auth = provider.auth || {};
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
          auth,
          ...(Array.isArray((provider as any).apiKey) ? { apiKey: (provider as any).apiKey } : {}),
          models: {}
        }
      },
      routing: {
        default: []
      }
    }
  } as JsonObject;
}

export type BuildConfigArgs = {
  providerId: string;
  provider: ProviderInputConfig;
  modelsFiltered: string[];
  outputPath: string;
};

export function buildOrUpdateProviderConfig(args: BuildConfigArgs): { config: JsonObject; summary: { added: string[]; removed: string[]; kept: string[]; completedWithTemplates: string[] } } {
  const { providerId, provider, modelsFiltered, outputPath } = args;
  const existing = readJson(outputPath) || ensureProviderSkeleton(providerId, provider);
  const provNode = ((existing.virtualrouter || {}).providers || {})[providerId] || ensureProviderSkeleton(providerId, provider).virtualrouter.providers[providerId];
  if (!existing.virtualrouter) (existing as any).virtualrouter = { outputProtocol: 'openai', providers: {}, routing: { default: [] } };
  if (!existing.virtualrouter.providers) existing.virtualrouter.providers = {};
  existing.virtualrouter.providers[providerId] = provNode;
  const currentModels: Record<string, any> = (provNode.models && typeof provNode.models === 'object') ? provNode.models : {};

  const currentSet = new Set(Object.keys(currentModels));
  const nextSet = new Set(modelsFiltered);
  const added: string[] = [], removed: string[] = [], kept: string[] = [], templated: string[] = [];

  // Remove blacklisted (not present) models
  for (const m of Array.from(currentSet)) {
    if (!nextSet.has(m)) { delete currentModels[m]; removed.push(m); }
  }
  // Add or merge models with templates
  for (const m of modelsFiltered) {
    const before = currentModels[m];
    const after = applyTemplates(providerId, m, before);
    if (!before) { added.push(m); if (after !== before) templated.push(m); }
    else {
      // Detect if template filled any missing fields
      const keys = Object.keys(after || {});
      let changed = false;
      for (const k of keys) { if (before[k] === undefined && after[k] !== undefined) { changed = true; break; } }
      if (changed) templated.push(m);
      kept.push(m);
    }
    currentModels[m] = after;
  }

  provNode.models = currentModels;

  // Ensure baseURL/auth are present from provider input (do not overwrite existing explicit non-empty values)
  const baseUrl = provider.baseUrl || provider.baseURL || '';
  if (baseUrl && !provNode.baseURL) provNode.baseURL = baseUrl;
  if (provider.auth && !provNode.auth) provNode.auth = provider.auth;
  // Preserve or set apiKey list; do not overwrite existing non-empty list
  if (Array.isArray((provider as any).apiKey)) {
    const existingList: string[] = Array.isArray(provNode.apiKey) ? provNode.apiKey as string[] : [];
    const next = Array.from(new Set([...(existingList||[]), ...((provider as any).apiKey as string[])])).filter(Boolean);
    if (next.length) provNode.apiKey = next;
    // Ensure auth.apiKey defaults to first key if not set
    if ((!provNode.auth || !provNode.auth.apiKey) && next.length) {
      provNode.auth = provNode.auth || { type: 'apikey' };
      if (!provNode.auth.type) provNode.auth.type = 'apikey';
      provNode.auth.apiKey = next[0];
    }
  }

  // Set default routing if empty
  const vr = existing.virtualrouter;
  const route = Array.isArray(vr.routing?.default) ? vr.routing.default : [];
  const routeModels = (route || []).map((r: string) => {
    const parts = String(r || '').split('.');
    return parts.length > 1 ? parts[1] : parts[0];
  }).filter(Boolean);
  const hasValidDefault = routeModels.some((m: string) => modelsFiltered.includes(m));
  if (!route || route.length === 0 || !hasValidDefault) {
    // Prefer glm-4.6 if available; else首个可用模型
    const preferred = modelsFiltered.includes('glm-4.6') ? 'glm-4.6' : (modelsFiltered[0] || null);
    if (preferred) vr.routing.default = [`${providerId}.${preferred}`];
  }

  // Ensure httpserver exists with a sane default for single-provider config
  if (!existing.httpserver || typeof existing.httpserver !== 'object') {
    (existing as any).httpserver = { port: 5521, host: '127.0.0.1' };
  }

  return { config: existing, summary: { added, removed, kept, completedWithTemplates: templated } };
}
