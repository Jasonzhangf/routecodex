import path from 'node:path';
import type * as fs from 'node:fs';

import { getInitProviderCatalog, type InitProviderTemplate } from './init-provider-catalog.js';

export type InitConfigIo = {
  fsImpl: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname' | 'resolve'>;
};

export type InitConfigPrompt = {
  prompt: (question: string) => Promise<string>;
};

export type InitConfigOptions = {
  configPath: string;
  force: boolean;
  host?: string;
  port?: number;
  providers?: string[];
  defaultProvider?: string;
};

export type InitConfigResult =
  | { ok: true; configPath: string; selectedProviders: string[]; defaultProvider: string; backupPath?: string }
  | { ok: false; reason: 'exists' | 'invalid_selection' | 'no_providers' | 'write_failed'; message: string };

function parseCsvList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeHost(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePort(input: string | undefined): number | undefined {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function indexCatalog(catalog: InitProviderTemplate[]) {
  const byId = new Map<string, InitProviderTemplate>();
  for (const entry of catalog) {
    byId.set(entry.id, entry);
  }
  return byId;
}

function buildRouting(defaultProviderId: string, defaultModel: string) {
  const target = `${defaultProviderId}.${defaultModel}`;
  const pool = { id: 'primary', mode: 'priority', targets: [target] };
  return {
    default: [pool],
    thinking: [{ ...pool, id: 'thinking-primary' }],
    tools: [{ ...pool, id: 'tools-primary' }]
  };
}

function buildDefaultWebSearchConfig(
  providers: InitProviderTemplate[]
): { webSearchRouteTargets: string[]; webSearchConfig: Record<string, unknown> } | null {
  const deepseekProvider = providers.find((provider) => provider.id === 'deepseek-web');
  const iflowProvider = providers.find((provider) => provider.id === 'iflow');
  if (!deepseekProvider && !iflowProvider) {
    return null;
  }

  const webSearchRouteTargets: string[] = [];
  const engines: Array<Record<string, unknown>> = [];
  const search: Record<string, unknown> = {};

  if (deepseekProvider) {
    const providerKey = `${deepseekProvider.id}.deepseek-chat-search`;
    webSearchRouteTargets.push(providerKey);
    engines.push({
      id: 'deepseek:web_search',
      providerKey,
      description: 'DeepSeek native web_search backend',
      default: true
    });
    search['deepseek:web_search'] = {
      providerKey
    };
  }

  if (iflowProvider) {
    const routeTarget = `${iflowProvider.id}.${iflowProvider.defaultModel}`;
    webSearchRouteTargets.push(routeTarget);
    engines.push({
      id: 'iflow:web_search',
      providerKey: 'iflow',
      description: 'iFlow web_search backend',
      ...(deepseekProvider ? {} : { default: true })
    });
    search['iflow:web_search'] = {
      providerKey: 'iflow'
    };
  }

  return {
    webSearchRouteTargets,
    webSearchConfig: {
      engines,
      search
    }
  };
}

export function buildInitConfigObject(
  selection: { providers: InitProviderTemplate[]; defaultProviderId: string; host: string; port: number }
): Record<string, unknown> {
  const providersNode: Record<string, unknown> = {};
  for (const tpl of selection.providers) {
    providersNode[tpl.id] = tpl.provider;
  }
  const defaultProvider = selection.providers.find((p) => p.id === selection.defaultProviderId) ?? selection.providers[0];
  if (!defaultProvider) {
    throw new Error('No providers selected');
  }
  const webSearchDefaults = buildDefaultWebSearchConfig(selection.providers);
  const routing = buildRouting(
    defaultProvider.id,
    defaultProvider.defaultModel
  ) as Record<string, unknown>;
  if (webSearchDefaults) {
    routing.web_search = [
      {
        id: 'web_search-primary',
        mode: 'priority',
        targets: webSearchDefaults.webSearchRouteTargets
      }
    ];
  }

  const result: Record<string, unknown> = {
    version: '1.0.0',
    httpserver: { host: selection.host, port: selection.port },
    virtualrouter: {
      providers: providersNode,
      routing
    }
  };
  if (webSearchDefaults) {
    result.webSearch = webSearchDefaults.webSearchConfig;
  }
  return result;
}

async function interactiveSelectProviders(prompt: InitConfigPrompt['prompt']): Promise<string[]> {
  const catalog = getInitProviderCatalog();
  const lines = catalog.map((p, idx) => `  ${idx + 1}) ${p.id} - ${p.label} (${p.description})`);
  const answer = await prompt(
    `Select providers by number (comma-separated). Default=1\n${lines.join('\n')}\n> `
  );
  const raw = answer.trim();
  if (!raw) {
    return [catalog[0]?.id].filter(Boolean) as string[];
  }
  const tokens = parseCsvList(raw);
  const indices = tokens
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const selected: string[] = [];
  for (const idx of indices) {
    const tpl = catalog[idx - 1];
    if (tpl && !selected.includes(tpl.id)) {
      selected.push(tpl.id);
    }
  }
  return selected;
}

async function interactivePickDefaultProvider(
  prompt: InitConfigPrompt['prompt'],
  selected: InitProviderTemplate[]
): Promise<string> {
  if (selected.length === 1) {
    return selected[0].id;
  }
  const lines = selected.map((p, idx) => `  ${idx + 1}) ${p.id} - ${p.label}`);
  const answer = await prompt(`Select default provider (for routing.default). Default=1\n${lines.join('\n')}\n> `);
  const n = Number(answer.trim());
  if (Number.isFinite(n) && n > 0 && Math.floor(n) <= selected.length) {
    return selected[Math.floor(n) - 1].id;
  }
  return selected[0].id;
}

async function interactiveHostPort(
  prompt: InitConfigPrompt['prompt'],
  defaults: { host: string; port: number }
): Promise<{ host: string; port: number }> {
  const hostAnswer = await prompt(`Server host (default=${defaults.host})\n> `);
  const portAnswer = await prompt(`Server port (default=${defaults.port})\n> `);
  return {
    host: normalizeHost(hostAnswer) ?? defaults.host,
    port: normalizePort(portAnswer) ?? defaults.port
  };
}

function computeBackupPath(fsImpl: InitConfigIo['fsImpl'], configPath: string): string {
  const base = `${configPath}.bak`;
  if (!fsImpl.existsSync(base)) {
    return base;
  }
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}.${i}`;
    if (!fsImpl.existsSync(candidate)) {
      return candidate;
    }
  }
  // Extremely unlikely; avoid an infinite loop in pathological environments.
  return `${base}.${Date.now()}`;
}

export async function initializeConfigV1(
  io: InitConfigIo,
  opts: InitConfigOptions,
  interactive?: InitConfigPrompt
): Promise<InitConfigResult> {
  const fsImpl = io.fsImpl;
  const pathImpl = io.pathImpl ?? path;

  const configPath = pathImpl.resolve(opts.configPath);
  const configDir = pathImpl.dirname(configPath);

  let backupPath: string | undefined;
  if (fsImpl.existsSync(configPath) && !opts.force) {
    return { ok: false, reason: 'exists', message: `Configuration file already exists: ${configPath}` };
  }

  if (!fsImpl.existsSync(configDir)) {
    fsImpl.mkdirSync(configDir, { recursive: true });
  }

  if (opts.force && fsImpl.existsSync(configPath)) {
    try {
      const previous = fsImpl.readFileSync(configPath, 'utf8');
      backupPath = computeBackupPath(fsImpl, configPath);
      fsImpl.writeFileSync(backupPath, previous, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'write_failed', message: `Failed to backup existing config: ${message}` };
    }
  }

  const catalog = getInitProviderCatalog();
  const byId = indexCatalog(catalog);

  let providerIds = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : undefined;
  if (!providerIds && interactive) {
    providerIds = await interactiveSelectProviders(interactive.prompt);
  }
  if (!providerIds || providerIds.length === 0) {
    return { ok: false, reason: 'no_providers', message: 'No providers selected' };
  }

  const selectedTemplates: InitProviderTemplate[] = [];
  for (const id of providerIds) {
    const tpl = byId.get(id);
    if (tpl) {
      selectedTemplates.push(tpl);
    }
  }

  if (!selectedTemplates.length) {
    return {
      ok: false,
      reason: 'invalid_selection',
      message: `No valid provider ids found. Supported: ${catalog.map((p) => p.id).join(', ')}`
    };
  }

  let defaultProviderId = opts.defaultProvider;
  if (!defaultProviderId && interactive) {
    defaultProviderId = await interactivePickDefaultProvider(interactive.prompt, selectedTemplates);
  }
  if (!defaultProviderId) {
    defaultProviderId = selectedTemplates[0].id;
  }
  if (!selectedTemplates.some((p) => p.id === defaultProviderId)) {
    return {
      ok: false,
      reason: 'invalid_selection',
      message: `defaultProvider "${defaultProviderId}" is not in selected providers: ${selectedTemplates.map((p) => p.id).join(', ')}`
    };
  }

  const defaults = { host: '127.0.0.1', port: 5555 };
  let host = opts.host ?? defaults.host;
  let port = opts.port ?? defaults.port;
  if (interactive && opts.host === undefined && opts.port === undefined) {
    const hp = await interactiveHostPort(interactive.prompt, { host, port });
    host = hp.host;
    port = hp.port;
  }

  const configObject = buildInitConfigObject({
    providers: selectedTemplates,
    defaultProviderId,
    host,
    port
  });

  try {
    fsImpl.writeFileSync(configPath, JSON.stringify(configObject, null, 2), 'utf8');
    return {
      ok: true,
      configPath,
      selectedProviders: selectedTemplates.map((p) => p.id),
      defaultProvider: defaultProviderId,
      backupPath
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'write_failed', message: `Failed to write config: ${message}` };
  }
}

export function parseProvidersArg(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  return parseCsvList(raw.trim());
}
