import type { Application, Request, Response } from 'express';
import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

import { DEFAULT_CONFIG, LOCAL_HOSTS } from '../../constants/index.js';
import { resolveRouteCodexConfigPath } from '../../config/config-paths.js';
import { getInitProviderCatalog } from '../../cli/config/init-provider-catalog.js';
import { loadProviderConfigsV2 } from '../../config/provider-v2-loader.js';
import { scanProviderTokenFiles, parseTokenSequenceFromPath } from '../../providers/auth/token-scanner/index.js';
import { ensureValidOAuthToken } from '../../providers/auth/oauth-lifecycle.js';
import type { OAuthAuth, OAuthAuthType } from '../../providers/core/api/provider-config.js';
import { readTokenFile, resolveAuthDir } from '../../token-daemon/token-utils.js';
import { registerOAuthPortalRoute } from './http-server/routes.js';
import {
  isLocalRequest,
  registerDaemonAdminRoutes
} from './http-server/daemon-admin-routes.js';

type UnknownRecord = Record<string, unknown>;

type InitServerConfig = {
  host?: string;
  port?: number;
  configPath?: string;
};

type ProviderSource = 'catalog' | 'config-v1' | 'config-v2';

type ProviderListItem = {
  id: string;
  label: string;
  description?: string;
  sources: ProviderSource[];
  authType?: string;
  models: string[];
  template?: Record<string, unknown>;
};

type InitStatusPayload = {
  ok: boolean;
  configPath: string;
  configExists: boolean;
  routePools: string[];
  camoufoxReady: boolean;
  port: number;
};

const STANDARD_ROUTES = [
  'default',
  'thinking',
  'tools',
  'coding',
  'search',
  'web_search',
  'vision',
  'longcontext'
];

const OAUTH_PROVIDER_IDS = new Set(['iflow', 'qwen', 'antigravity', 'gemini-cli']);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAliasInput(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw;
}

function isValidEnglishAlias(value: string): boolean {
  if (!value) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9]*$/.test(value);
}

function deriveAliasFromEmail(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const at = value.indexOf('@');
  const prefix = at >= 0 ? value.slice(0, at) : value;
  const cleaned = prefix.replace(/\./g, '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) {
    return null;
  }
  return isValidEnglishAlias(cleaned) ? cleaned : null;
}

function resolveConfigPath(explicit?: string): string {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  return resolveRouteCodexConfigPath();
}

function readConfigFile(configPath: string): UnknownRecord | null {
  try {
    if (!fsSync.existsSync(configPath)) {
      return null;
    }
    const raw = fsSync.readFileSync(configPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return asRecord(parsed) ?? {};
  } catch {
    return null;
  }
}

function extractProvidersV1(config: UnknownRecord | null): Record<string, UnknownRecord> {
  if (!config) {
    return {};
  }
  const vr = asRecord(config.virtualrouter);
  const providers = vr ? asRecord(vr.providers) : undefined;
  if (!providers) {
    return {};
  }
  const result: Record<string, UnknownRecord> = {};
  for (const [id, value] of Object.entries(providers)) {
    const rec = asRecord(value);
    if (rec && id.trim()) {
      result[id.trim()] = rec;
    }
  }
  return result;
}

function extractRoutingRoutes(config: UnknownRecord | null): string[] {
  if (!config) {
    return [];
  }
  const vr = asRecord(config.virtualrouter);
  const routing = vr ? asRecord(vr.routing) : undefined;
  const rootRouting = asRecord(config.routing);
  const node = routing ?? rootRouting;
  if (!node) {
    return [];
  }
  return Object.keys(node).filter((key) => key && key.trim());
}

function extractModelsFromProvider(provider: UnknownRecord | null): string[] {
  if (!provider) {
    return [];
  }
  const modelsNode = asRecord(provider.models);
  if (!modelsNode) {
    return [];
  }
  return Object.keys(modelsNode).filter((key) => key && key.trim());
}

function extractAuthType(provider: UnknownRecord | null): string | undefined {
  if (!provider) {
    return undefined;
  }
  const auth = asRecord(provider.auth);
  const raw = readString(auth?.type ?? provider.authType);
  return raw ? raw.toLowerCase() : undefined;
}

function extractModelsFromV2(provider: UnknownRecord | null): string[] {
  if (!provider) {
    return [];
  }
  const modelsNode = asRecord(provider.models);
  if (modelsNode) {
    return Object.keys(modelsNode).filter((key) => key && key.trim());
  }
  const defaults = provider.defaultModels;
  if (Array.isArray(defaults)) {
    return defaults.map((m) => String(m)).filter((m) => m && m.trim());
  }
  return [];
}

function mergeProviderLists(items: ProviderListItem[]): ProviderListItem[] {
  const map = new Map<string, ProviderListItem>();
  for (const item of items) {
    if (!item.id) {
      continue;
    }
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, {
        ...item,
        sources: Array.from(new Set(item.sources))
      });
      continue;
    }
    const mergedSources = Array.from(new Set([...existing.sources, ...item.sources]));
    const mergedModels = Array.from(new Set([...existing.models, ...item.models]));
    const next: ProviderListItem = {
      ...existing,
      label: existing.label || item.label,
      description: existing.description || item.description,
      sources: mergedSources,
      models: mergedModels.sort((a, b) => a.localeCompare(b)),
      authType: existing.authType || item.authType,
      template: existing.template ?? item.template
    };
    map.set(item.id, next);
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function buildRoutePools(config: UnknownRecord | null): string[] {
  const base = new Set(STANDARD_ROUTES);
  for (const key of extractRoutingRoutes(config)) {
    base.add(key);
  }
  return Array.from(base);
}

function resolveCamoufoxReady(): boolean {
  const override = String(process.env.ROUTECODEX_OAUTH_BROWSER || '').trim().toLowerCase();
  if (override === 'camoufox') {
    return true;
  }
  try {
    const candidates = [
      path.resolve(process.cwd(), 'scripts', 'camoufox', 'launch-auth.mjs'),
      path.resolve(process.cwd(), 'dist', 'scripts', 'camoufox', 'launch-auth.mjs')
    ];
    return candidates.some((candidate) => fsSync.existsSync(candidate));
  } catch {
    return false;
  }
}

async function collectProviders(config: UnknownRecord | null): Promise<ProviderListItem[]> {
  const items: ProviderListItem[] = [];

  const catalog = getInitProviderCatalog();
  for (const entry of catalog) {
    const authType = extractAuthType(asRecord(entry.provider));
    items.push({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      sources: ['catalog'],
      authType,
      models: extractModelsFromProvider(asRecord(entry.provider)),
      template: entry.provider
    });
  }

  const v1Providers = extractProvidersV1(config);
  for (const [id, provider] of Object.entries(v1Providers)) {
    items.push({
      id,
      label: id,
      sources: ['config-v1'],
      authType: extractAuthType(provider),
      models: extractModelsFromProvider(provider)
    });
  }

  try {
    const v2Configs = await loadProviderConfigsV2();
    for (const cfg of Object.values(v2Configs)) {
      const provider = asRecord(cfg.provider) ?? {};
      const authType = extractAuthType(provider);
      items.push({
        id: cfg.providerId,
        label: cfg.providerId,
        sources: ['config-v2'],
        authType,
        models: extractModelsFromV2(provider)
      });
    }
  } catch {
    // ignore v2 load failures
  }

  return mergeProviderLists(items);
}

async function allocateOAuthTokenFile(provider: string, alias: string): Promise<string> {
  const matches = await scanProviderTokenFiles(provider);
  let maxSeq = 0;
  for (const match of matches) {
    if (match.sequence > maxSeq) {
      maxSeq = match.sequence;
    }
  }
  const nextSeq = maxSeq + 1;
  const safeAlias = alias.trim() ? alias.trim() : 'default';
  const filename = `${provider}-oauth-${nextSeq}-${safeAlias}.json`;
  const authDir = resolveAuthDir();
  return path.join(authDir, filename);
}

async function allocateApiKeyFileName(provider: string, alias: string): Promise<string> {
  const authDir = resolveAuthDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    entries = [];
  }
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const safeAlias = alias.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  let maxSeq = 0;
  for (const entry of entries) {
    const match = entry.match(/^(.+)-apikey-(\d+)(?:-(.+))?\.key$/i);
    if (!match) {
      continue;
    }
    if (match[1]?.toLowerCase() !== safeProvider) {
      continue;
    }
    const seq = Number(match[2]);
    if (Number.isFinite(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  const nextSeq = maxSeq + 1;
  return `${safeProvider}-apikey-${nextSeq}-${safeAlias}.key`;
}

async function writeConfigFile(configPath: string, payload: UnknownRecord): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function finalizeOAuthAlias(
  provider: string,
  tokenFilePath: string,
  requestedAlias?: string
): Promise<{ alias: string; tokenFile: string; email?: string; suggestedAlias?: string }> {
  const normalizedAlias = requestedAlias && requestedAlias.trim() ? requestedAlias.trim() : '';
  const token = await readTokenFile(tokenFilePath);
  const email = typeof token?.email === 'string' && token.email.trim() ? token.email.trim() : undefined;
  const suggestedAlias = deriveAliasFromEmail(email);
  let alias = normalizedAlias;
  if (!alias || !isValidEnglishAlias(alias)) {
    alias = suggestedAlias ?? '';
  }
  if (!alias) {
    return {
      alias: normalizedAlias || 'default',
      tokenFile: tokenFilePath,
      email,
      suggestedAlias: suggestedAlias ?? undefined
    };
  }

  const parsed = parseTokenSequenceFromPath(tokenFilePath);
  let targetPath = tokenFilePath;
  if (parsed) {
    const candidate = path.join(path.dirname(tokenFilePath), `${provider}-oauth-${parsed.sequence}-${alias}.json`);
    targetPath = candidate;
  }
  if (targetPath !== tokenFilePath) {
    if (fsSync.existsSync(targetPath)) {
      targetPath = await allocateOAuthTokenFile(provider, alias);
    }
    try {
      await fs.rename(tokenFilePath, targetPath);
    } catch {
      targetPath = tokenFilePath;
    }
  }

  return { alias, tokenFile: targetPath, email, suggestedAlias: suggestedAlias ?? undefined };
}

function normalizeRoutingPayload(raw: UnknownRecord | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [routeName, poolsRaw] of Object.entries(raw)) {
    if (!Array.isArray(poolsRaw)) {
      continue;
    }
    const pools: Record<string, unknown>[] = [];
    for (const [index, poolRaw] of poolsRaw.entries()) {
      const pool = asRecord(poolRaw);
      if (!pool) {
        continue;
      }
      const targetsRaw = Array.isArray(pool.targets) ? pool.targets : [];
      const targets = targetsRaw
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item);
      if (!targets.length) {
        continue;
      }
      const id = readString(pool.id) ?? `${routeName}-${index + 1}`;
      const next: Record<string, unknown> = {
        id,
        targets
      };
      if (readString(pool.mode)) {
        next.mode = readString(pool.mode);
      }
      if (typeof pool.priority === 'number' && Number.isFinite(pool.priority)) {
        next.priority = pool.priority;
      }
      if (pool.backup === true) {
        next.backup = true;
      }
      pools.push(next);
    }
    result[routeName] = pools;
  }
  return result;
}

export class RouteCodexInitServer {
  private readonly app: Application;
  private server?: Server;
  private readonly configPath: string;
  private readonly host: string;
  private readonly port: number;

  constructor(config?: InitServerConfig) {
    this.configPath = resolveConfigPath(config?.configPath);
    this.host = config?.host ?? LOCAL_HOSTS.IPV4;
    this.port = typeof config?.port === 'number' && Number.isFinite(config.port) && config.port > 0
      ? Math.floor(config.port)
      : DEFAULT_CONFIG.PORT;

    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));

    registerOAuthPortalRoute(this.app);
    this.registerInitUiRoute();
    this.registerInitApiRoutes();
    this.registerAdminUiRoute();
    this.registerAdminRoutes();
  }

  private registerInitUiRoute(): void {
    this.app.get('/init', async (_req: Request, res: Response) => {
      try {
        const config = readConfigFile(this.configPath);
        if (config) {
          res.redirect('/daemon/admin');
          return;
        }
        let html = '';
        try {
          const filePath = new URL('../../../docs/init-ui.html', import.meta.url);
          html = await fs.readFile(filePath, 'utf8');
        } catch {
          const fallback = path.join(process.cwd(), 'docs', 'init-ui.html');
          html = await fs.readFile(fallback, 'utf8');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.send(html);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });
  }

  private registerInitApiRoutes(): void {
    const rejectNonLocal = (req: Request, res: Response): boolean => {
      if (isLocalRequest(req)) {
        return false;
      }
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return true;
    };

    this.app.get('/init/status', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const config = readConfigFile(this.configPath);
      const payload: InitStatusPayload = {
        ok: true,
        configPath: this.configPath,
        configExists: Boolean(config),
        routePools: buildRoutePools(config),
        camoufoxReady: resolveCamoufoxReady(),
        port: this.port
      };
      res.status(200).json(payload);
    });

    this.app.get('/init/providers', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const config = readConfigFile(this.configPath);
      try {
        const providers = await collectProviders(config);
        res.status(200).json({ ok: true, providers });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });

    this.app.get('/init/oauth/tokens', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const provider = readString(req.query.provider);
      if (!provider) {
        res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
        return;
      }
      try {
        const matches = await scanProviderTokenFiles(provider);
        const tokens = [];
        for (const match of matches) {
          const token = await readTokenFile(match.filePath);
          const email = typeof token?.email === 'string' && token.email.trim() ? token.email.trim() : undefined;
          tokens.push({
            alias: match.alias,
            tokenFile: match.filePath,
            email
          });
        }
        res.status(200).json({ ok: true, provider, tokens });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });

    this.app.post('/init/credentials/apikey', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const body = req.body as UnknownRecord;
      const provider = readString(body?.provider);
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!provider) {
        res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
        return;
      }
      if (!items.length) {
        res.status(400).json({ error: { message: 'items is required', code: 'bad_request' } });
        return;
      }
      try {
        const authDir = resolveAuthDir();
        await fs.mkdir(authDir, { recursive: true });
        const results: Array<{ alias: string; secretRef: string; fileName: string }> = [];
        for (const item of items) {
          const entry = asRecord(item);
          if (!entry) {
            continue;
          }
          const alias = readString(entry.alias) ?? 'default';
          const apiKey = readString(entry.apiKey);
          if (!apiKey) {
            continue;
          }
          const fileName = await allocateApiKeyFileName(provider, alias);
          const filePath = path.join(authDir, fileName);
          await fs.writeFile(filePath, `${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
          results.push({
            alias,
            secretRef: `authfile-${fileName}`,
            fileName
          });
        }
        res.status(200).json({ ok: true, provider, items: results });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });

    this.app.post('/init/oauth/prepare', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const body = req.body as UnknownRecord;
      const provider = readString(body?.provider);
      const alias = normalizeAliasInput(body?.alias);
      if (!provider) {
        res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
        return;
      }
      if (!alias || !isValidEnglishAlias(alias)) {
        res.status(400).json({ error: { message: 'alias is required and must be English letters/numbers', code: 'bad_request' } });
        return;
      }
      try {
        const tokenFile = await allocateOAuthTokenFile(provider, alias);
        res.status(200).json({ ok: true, provider, alias, tokenFile });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });

    this.app.post('/init/oauth/authorize', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const body = req.body as UnknownRecord;
      const provider = readString(body?.provider);
      const alias = normalizeAliasInput(body?.alias);
      const tokenFile = readString(body?.tokenFile);
      const openBrowser = body?.openBrowser !== false;
      const forceReauthorize = body?.forceReauthorize === true;
      if (!provider) {
        res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
        return;
      }
      if (alias && !isValidEnglishAlias(alias)) {
        res.status(400).json({ error: { message: 'alias must be English letters/numbers', code: 'bad_request' } });
        return;
      }
      try {
        const type: OAuthAuthType =
          provider === 'gemini-cli' ? 'gemini-cli-oauth' : (`${provider}-oauth` as OAuthAuthType);
        const tempAlias = alias && isValidEnglishAlias(alias) ? alias : `pending${Date.now() % 100000}`;
        const resolvedTokenFile = tokenFile ?? (await allocateOAuthTokenFile(provider, tempAlias));
        const auth: OAuthAuth = { type, tokenFile: resolvedTokenFile };
        await ensureValidOAuthToken(provider, auth, {
          openBrowser,
          forceReauthorize,
          forceReacquireIfRefreshFails: true
        });
        const finalized = await finalizeOAuthAlias(provider, resolvedTokenFile, alias || undefined);
        res.status(200).json({
          ok: true,
          provider,
          alias: finalized.alias,
          tokenFile: finalized.tokenFile,
          email: finalized.email,
          suggestedAlias: finalized.suggestedAlias
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });

    this.app.post('/init/config/save', async (req: Request, res: Response) => {
      if (rejectNonLocal(req, res)) {return;}
      const body = req.body as UnknownRecord;
      const providers = asRecord(body?.providers) ?? {};
      const routingRaw = asRecord(body?.routing) ?? {};
      const modeRaw = readString(body?.mode);
      const host = readString(body?.host) ?? LOCAL_HOSTS.IPV4;
      const port = typeof body?.port === 'number' && Number.isFinite(body.port) && body.port > 0
        ? Math.floor(body.port as number)
        : DEFAULT_CONFIG.PORT;
      const routing = normalizeRoutingPayload(routingRaw);
      const mode = modeRaw === 'v2' ? 'v2' : 'v1';
      const totalTargets = Object.values(routing)
        .flatMap((pools) => (Array.isArray(pools) ? pools : []))
        .reduce((acc, pool) => {
          const targets = asRecord(pool)?.targets;
          if (Array.isArray(targets)) {
            return acc + targets.length;
          }
          return acc;
        }, 0);
      if (totalTargets === 0) {
        res.status(400).json({ error: { message: 'routing must include at least one target', code: 'bad_request' } });
        return;
      }
      const defaultPools = routing.default;
      const defaultHasTargets = Array.isArray(defaultPools) && defaultPools.some((pool) => {
        const targets = asRecord(pool)?.targets;
        return Array.isArray(targets) && targets.length > 0;
      });
      if (!defaultHasTargets) {
        res.status(400).json({ error: { message: 'routing.default must include at least one target', code: 'bad_request' } });
        return;
      }
      const payload: UnknownRecord = {
        version: '1.0.0',
        httpserver: { host, port },
        ...(mode === 'v2' ? { virtualrouterMode: 'v2' } : {}),
        virtualrouter: {
          providers: mode === 'v2' ? {} : providers,
          routing
        }
      };
      try {
        await writeConfigFile(this.configPath, payload);
        res.status(200).json({ ok: true, path: this.configPath });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });
  }

  private registerAdminUiRoute(): void {
    this.app.get('/daemon/admin', async (_req: Request, res: Response) => {
      try {
        let html = '';
        try {
          const filePath = new URL('../../../docs/daemon-admin-ui.html', import.meta.url);
          html = await fs.readFile(filePath, 'utf8');
        } catch {
          const fallback = path.join(process.cwd(), 'docs', 'daemon-admin-ui.html');
          html = await fs.readFile(fallback, 'utf8');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-RouteCodex-Version', String(process.env.ROUTECODEX_VERSION || 'dev'));
        res.send(html);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: { message } });
      }
    });
  }

  private registerAdminRoutes(): void {
    registerDaemonAdminRoutes({
      app: this.app,
      getManagerDaemon: () => null,
      getServerId: () => `${this.host}:${this.port}`,
      getVirtualRouterArtifacts: () => null
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
  }

  getServerConfig(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }
}
