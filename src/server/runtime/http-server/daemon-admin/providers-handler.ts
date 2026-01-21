import type { Application, Request, Response } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import type { VirtualRouterArtifacts, ProviderProtocol } from '../types.js';
import { loadProviderConfigsV2 } from '../../../../config/provider-v2-loader.js';
import type { ProviderConfigV2 } from '../../../../config/provider-v2-loader.js';
import { resolveRouteCodexConfigPath } from '../../../../config/config-paths.js';

interface ProviderRuntimeView {
  providerKey: string;
  runtimeKey: string;
  family?: string;
  protocol?: ProviderProtocol | string;
  series?: string;
  enabled: boolean;
}

interface ProviderConfigV2Summary {
  id: string;
  family?: string;
  protocol?: string;
  enabled: boolean;
  defaultModels?: string[];
  credentialsRef?: string;
  version: string;
}

type RoutingLocation = 'virtualrouter.routing' | 'routing';
interface RoutingSnapshot {
  routing: Record<string, unknown>;
  location: RoutingLocation;
  version: string | null;
}

interface RoutingSourceSummary {
  id: string;
  kind: 'active' | 'routecodex' | 'import' | 'provider';
  label: string;
  path: string;
  location: RoutingLocation;
  version: string | null;
}

export function registerProviderRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  const reject = (req: Request, res: Response) => rejectNonLocalOrUnauthorizedAdmin(req, res);

  app.get('/providers/runtimes', (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const artifacts = options.getVirtualRouterArtifacts() as VirtualRouterArtifacts | null;
      const targetRuntime = artifacts?.targetRuntime ?? {};
      const items: ProviderRuntimeView[] = [];
      for (const [runtimeKey, runtime] of Object.entries(targetRuntime)) {
        const providerKey =
          typeof (runtime as { providerKey?: unknown }).providerKey === 'string'
            ? ((runtime as { providerKey?: string }).providerKey as string)
            : runtimeKey;
        const family =
          typeof (runtime as { providerFamily?: unknown }).providerFamily === 'string'
            ? ((runtime as { providerFamily?: string }).providerFamily as string)
            : undefined;
        const protocol =
          typeof (runtime as { providerProtocol?: unknown }).providerProtocol === 'string'
            ? ((runtime as { providerProtocol?: string }).providerProtocol as string)
            : undefined;
        const series =
          typeof (runtime as { series?: unknown }).series === 'string'
            ? ((runtime as { series?: string }).series as string)
            : undefined;
        items.push({
          providerKey,
          runtimeKey,
          family,
          protocol,
          series,
          enabled: true
        });
      }
      res.status(200).json(items);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/config/routing/sources', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const sources = await listRoutingSources();
      res.status(200).json({
        ok: true,
        activePath: pickUserConfigPath(),
        sources
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  // Config V1 Provider Pool：基于 user config (virtualrouter.providers) 的声明性配置。
  // 注意：该接口只落盘，不做热更新；调用方需重启 routecodex 以应用更改。
  app.get('/config/providers', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const providers = extractProvidersV1(parsed);
      const items = Object.entries(providers).map(([id, provider]) => ({
        id,
        ...summarizeProviderV1(provider)
      }));
      items.sort((a, b) => a.id.localeCompare(b.id));
      res.status(200).json({ ok: true, path: configPath, providers: items });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  // Config V2 Provider 视图：基于 ~/.routecodex/provider/*/config.v2.json 的声明性配置。
  app.get('/config/providers/v2', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const configs = await loadProviderConfigsV2();
      const items: ProviderConfigV2Summary[] = Object.values(configs).map((cfg: ProviderConfigV2) => {
        const provider = cfg.provider as Record<string, unknown>;
        const family =
          typeof provider.providerType === 'string'
            ? (provider.providerType as string)
            : undefined;
        const protocol =
          typeof provider.compatibilityProfile === 'string'
            ? (provider.compatibilityProfile as string)
            : undefined;
        const enabled =
          typeof provider.enabled === 'boolean'
            ? (provider.enabled as boolean)
            : true;
        const defaultModels = extractDefaultModels(provider);
        const credentialsRef = extractCredentialsRef(provider);
        return {
          id: cfg.providerId,
          family,
          protocol,
          enabled,
          defaultModels,
          credentialsRef,
          version: cfg.version
        };
      });
      res.status(200).json(items);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/config/providers/v2/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required' } });
      return;
    }
    try {
      const configs = await loadProviderConfigsV2();
      const cfg = configs[id];
      if (!cfg) {
        res.status(404).json({ error: { message: 'provider config not found', code: 'not_found' } });
        return;
      }
      const provider = scrubProviderConfig(cfg.provider);
      res.status(200).json({
        id: cfg.providerId,
        version: cfg.version,
        provider
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/config/providers/v2/:id/preview-route', (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required' } });
      return;
    }
    res.status(200).json({
      id,
      route: null,
      series: null,
      description: [
        'Route preview is not yet implemented for Config V2; virtual router builder does not expose a stable description API.'
      ]
    });
  });

  app.post('/config/providers/v2', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const body = req.body as Record<string, unknown>;
    const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : '';
    const version = typeof body?.version === 'string' && body.version.trim() ? body.version.trim() : '2.0.0';
    const provider = body?.provider;
    if (!providerId) {
      res.status(400).json({ error: { message: 'providerId is required', code: 'bad_request' } });
      return;
    }
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      res.status(400).json({ error: { message: 'provider must be an object', code: 'bad_request' } });
      return;
    }

    const normalizedProvider = validateAndNormalizeProviderConfig(providerId, provider as Record<string, unknown>);
    if (!normalizedProvider.ok) {
      res.status(400).json({ error: { message: normalizedProvider.message, code: 'bad_request' } });
      return;
    }

    try {
      const rootDir = pickProviderRootDir();
      const dirPath = path.join(rootDir, providerId);
      await fs.mkdir(dirPath, { recursive: true });
      const filePath = path.join(dirPath, 'config.v2.json');
      const payload: ProviderConfigV2 = {
        version,
        providerId,
        provider: normalizedProvider.provider
      };
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      res.status(200).json({ ok: true, providerId, path: filePath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.delete('/config/providers/v2/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    try {
      const rootDir = pickProviderRootDir();
      const filePath = path.join(rootDir, id, 'config.v2.json');
      await fs.unlink(filePath);
      res.status(200).json({ ok: true, id });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: { message: 'provider config not found', code: 'not_found' } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  // Config V1 Provider Pool (by provider id).
  // NOTE: put this after `/config/providers/v2/*` so `/config/providers/v2` is not shadowed.
  app.get('/config/providers/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const providers = extractProvidersV1(parsed);
      const provider = providers[id];
      if (!provider) {
        res.status(404).json({ error: { message: 'provider not found', code: 'not_found' } });
        return;
      }
      res.status(200).json({
        ok: true,
        id,
        provider: scrubProviderConfigV1(provider)
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.put('/config/providers/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const providerNode = body?.provider;
    if (!providerNode || typeof providerNode !== 'object' || Array.isArray(providerNode)) {
      res.status(400).json({ error: { message: 'provider must be an object', code: 'bad_request' } });
      return;
    }
    const normalized = validateAndNormalizeProviderConfigV1(id, providerNode as Record<string, unknown>);
    if (!normalized.ok) {
      res.status(400).json({ error: { message: normalized.message, code: 'bad_request' } });
      return;
    }
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const next = applyProviderUpsertV1(parsed, id, normalized.provider);
      await backupFile(configPath);
      await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf8');
      res.status(200).json({ ok: true, id, path: configPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.delete('/config/providers/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const next = applyProviderDeleteV1(parsed, id);
      await backupFile(configPath);
      await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf8');
      res.status(200).json({ ok: true, id, path: configPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/config/routing', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const configPath = resolveAllowedAdminFilePath(readQueryString(req, 'path'));
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const snapshot = extractRoutingSnapshot(parsed);
      res.status(200).json({ ok: true, path: configPath, ...snapshot });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'forbidden_path') {
        res.status(403).json({ error: { message: 'path is not allowed', code: 'forbidden' } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.put('/config/routing', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const body = req.body as Record<string, unknown>;
    const routingNode = body?.routing;
    const locationNode = body?.location;
    if (!routingNode || typeof routingNode !== 'object' || Array.isArray(routingNode)) {
      res.status(400).json({ error: { message: 'routing must be an object', code: 'bad_request' } });
      return;
    }
    if (locationNode !== undefined && locationNode !== 'virtualrouter.routing' && locationNode !== 'routing') {
      res.status(400).json({ error: { message: 'location must be "virtualrouter.routing" or "routing"', code: 'bad_request' } });
      return;
    }
    try {
      const configPath = resolveAllowedAdminFilePath(
        readQueryString(req, 'path') || (typeof body?.path === 'string' ? body.path : undefined)
      );
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const detected = extractRoutingSnapshot(parsed);
      const location = (locationNode as RoutingLocation | undefined) ?? detected.location;
      const next = applyRoutingAtLocation(parsed, routingNode as Record<string, unknown>, location);
      await backupFile(configPath);
      await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf8');
      res.status(200).json({ ok: true, path: configPath, location });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'forbidden_path') {
        res.status(403).json({ error: { message: 'path is not allowed', code: 'forbidden' } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/config/settings', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const oauthBrowser =
        typeof (parsed as { oauthBrowser?: unknown }).oauthBrowser === 'string'
          ? ((parsed as { oauthBrowser?: string }).oauthBrowser as string)
          : undefined;
      res.status(200).json({
        ok: true,
        path: configPath,
        oauthBrowser: oauthBrowser && oauthBrowser.trim() ? oauthBrowser.trim() : null,
        providerDir: pickProviderRootDir(),
        authDir: path.join(os.homedir(), '.routecodex', 'auth')
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.put('/config/settings', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const body = req.body as Record<string, unknown>;
    const oauthBrowser = typeof body?.oauthBrowser === 'string' ? body.oauthBrowser.trim() : '';
    if (!oauthBrowser) {
      res.status(400).json({ error: { message: 'oauthBrowser is required', code: 'bad_request' } });
      return;
    }
    try {
      const configPath = pickUserConfigPath();
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const next = { ...(parsed as Record<string, unknown>), oauthBrowser };
      await backupFile(configPath);
      await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf8');
      // apply immediately for oauth flows without requiring restart
      process.env.ROUTECODEX_OAUTH_BROWSER = oauthBrowser;
      res.status(200).json({ ok: true, path: configPath, oauthBrowser });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });
}

function extractDefaultModels(provider: Record<string, unknown>): string[] | undefined {
  const modelsNode = provider.models as unknown;
  if (!modelsNode || typeof modelsNode !== 'object' || Array.isArray(modelsNode)) {
    return undefined;
  }
  const keys = Object.keys(modelsNode as Record<string, unknown>);
  return keys.length ? keys : undefined;
}

function extractCredentialsRef(provider: Record<string, unknown>): string | undefined {
  const auth = provider.auth as unknown;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const entries = (auth as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const first = entries[0] as { tokenFile?: unknown };
  if (typeof first.tokenFile === 'string' && first.tokenFile.trim()) {
    return first.tokenFile.trim();
  }
  return undefined;
}

function scrubProviderConfig(provider: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...provider };
  const auth = clone.auth as unknown;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const safeAuth: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    // 删除潜在的敏感字段（目前 v2 配置中一般不存在这些字段，此处为防御性实现）。
    delete safeAuth.apiKey;
    delete safeAuth.api_key;
    delete safeAuth.clientSecret;
    delete safeAuth.secret;
    clone.auth = safeAuth;
  }
  return clone;
}

function isSafeSecretReference(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('authfile-')) {
    return true;
  }
  if (/^\$\{[A-Z0-9_]+\}$/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return true;
  }
  return false;
}

function extractProvidersV1(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  const root = config as Record<string, unknown>;
  const vrNode = root.virtualrouter;
  if (!vrNode || typeof vrNode !== 'object' || Array.isArray(vrNode)) {
    return {};
  }
  const providersNode = (vrNode as Record<string, unknown>).providers;
  if (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode)) {
    return providersNode as Record<string, unknown>;
  }
  return {};
}

function applyProviderUpsertV1(config: unknown, id: string, provider: Record<string, unknown>): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  const providersNode = vr.providers;
  const providers = (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode))
    ? (providersNode as Record<string, unknown>)
    : {};
  return {
    ...root,
    virtualrouter: {
      ...vr,
      providers: {
        ...providers,
        [id]: { ...provider, id }
      }
    }
  };
}

function applyProviderDeleteV1(config: unknown, id: string): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  const providersNode = vr.providers;
  const providers = (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode))
    ? ({ ...(providersNode as Record<string, unknown>) })
    : {};
  delete providers[id];
  return {
    ...root,
    virtualrouter: {
      ...vr,
      providers
    }
  };
}

function summarizeProviderV1(provider: unknown): Record<string, unknown> {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return { type: null, enabled: null, baseURL: null, modelCount: 0, modelsPreview: [], authType: null };
  }
  const rec = provider as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : null;
  const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : null;
  const baseURL = typeof rec.baseURL === 'string' ? rec.baseURL : null;
  const compatibilityProfile = typeof rec.compatibilityProfile === 'string' ? rec.compatibilityProfile : null;
  const models = rec.models;
  const modelsPreview =
    models && typeof models === 'object' && !Array.isArray(models)
      ? Object.keys(models as Record<string, unknown>).sort((a, b) => a.localeCompare(b)).slice(0, 6)
      : [];
  const modelCount =
    models && typeof models === 'object' && !Array.isArray(models)
      ? Object.keys(models as Record<string, unknown>).length
      : 0;
  const auth = rec.auth;
  const authType =
    auth && typeof auth === 'object' && !Array.isArray(auth) && typeof (auth as Record<string, unknown>).type === 'string'
      ? ((auth as Record<string, unknown>).type as string)
      : null;
  return { type, enabled, baseURL, compatibilityProfile, modelCount, modelsPreview, authType };
}

function scrubProviderConfigV1(provider: unknown): Record<string, unknown> {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return {};
  }
  const clone: Record<string, unknown> = { ...(provider as Record<string, unknown>) };
  const auth = clone.auth as unknown;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const authClone: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    const fields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret', 'cookie'];
    for (const field of fields) {
      const raw = authClone[field];
      if (raw === undefined) {
        continue;
      }
      if (typeof raw === 'string' && isSafeSecretReference(raw)) {
        continue;
      }
      delete authClone[field];
    }
    clone.auth = authClone;
  }
  return clone;
}

function validateAndNormalizeProviderConfigV1(
  providerId: string,
  provider: Record<string, unknown>
): { ok: true; provider: Record<string, unknown> } | { ok: false; message: string } {
  const idNode = typeof provider.id === 'string' ? provider.id.trim() : '';
  if (idNode && idNode !== providerId) {
    return { ok: false, message: `provider.id must match id (${providerId})` };
  }

  const auth = provider.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { ok: false, message: 'provider.auth must be an object' };
  }
  const authRec = auth as Record<string, unknown>;
  const secretFields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret', 'cookie'];
  for (const field of secretFields) {
    const value = authRec[field];
    if (typeof value === 'string' && value.trim()) {
      if (!isSafeSecretReference(value)) {
        return {
          ok: false,
          message: `provider.auth must not include inline secret field "${field}". Use authfile-* or an env var reference (e.g. \${MY_KEY}).`
        };
      }
    }
  }

  return { ok: true, provider: { ...provider, id: providerId } };
}

function pickProviderRootDir(): string {
  const envPath = process.env.ROUTECODEX_PROVIDER_DIR;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath.trim());
  }
  return path.join(pickHomeDir(), '.routecodex', 'provider');
}

function pickHomeDir(): string {
  const home = process.env.HOME;
  if (home && home.trim()) {
    return path.resolve(home.trim());
  }
  return os.homedir();
}

function pickUserConfigPath(): string {
  const envPaths = [
    process.env.RCC4_CONFIG_PATH,
    process.env.ROUTECODEX_CONFIG,
    process.env.ROUTECODEX_CONFIG_PATH
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const p of envPaths) {
    try {
      if (p && fsSync.existsSync(p) && fsSync.statSync(p).isFile()) {
        return p;
      }
    } catch {
      // ignore
    }
  }
  return resolveRouteCodexConfigPath();
}

function extractRoutingSnapshot(config: unknown): RoutingSnapshot {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { routing: {}, location: 'virtualrouter.routing', version: null };
  }
  const root = config as Record<string, unknown>;
  const version = typeof root.version === 'string' ? root.version : null;

  const vr = root.virtualrouter;
  if (vr && typeof vr === 'object' && !Array.isArray(vr)) {
    const routingNode = (vr as Record<string, unknown>).routing;
    if (routingNode && typeof routingNode === 'object' && !Array.isArray(routingNode)) {
      return { routing: routingNode as Record<string, unknown>, location: 'virtualrouter.routing', version };
    }
    return { routing: {}, location: 'virtualrouter.routing', version };
  }

  const routingNode = root.routing;
  if (routingNode && typeof routingNode === 'object' && !Array.isArray(routingNode)) {
    return { routing: routingNode as Record<string, unknown>, location: 'routing', version };
  }
  return { routing: {}, location: 'routing', version };
}

function applyRoutingAtLocation(
  config: unknown,
  routing: Record<string, unknown>,
  location: RoutingLocation
): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  if (location === 'routing') {
    return { ...root, routing };
  }
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  return { ...root, virtualrouter: { ...vr, routing } };
}

function readQueryString(req: Request, key: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function expandTilde(inputPath: string): string {
  if (!inputPath.startsWith('~')) {
    return inputPath;
  }
  if (inputPath === '~') {
    return pickHomeDir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(pickHomeDir(), inputPath.slice(2));
  }
  return inputPath;
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
  const base = path.resolve(dirPath);
  const abs = path.resolve(filePath);
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..');
}

function resolveAllowedAdminFilePath(inputPath: string | undefined): string {
  const active = pickUserConfigPath();
  if (!inputPath) {
    return active;
  }
  const expanded = expandTilde(inputPath);
  const resolved = path.resolve(expanded);
  if (resolved === active) {
    return resolved;
  }
  const routecodexHome = path.join(pickHomeDir(), '.routecodex');
  const providerRoot = pickProviderRootDir();
  if (isPathWithinDir(resolved, routecodexHome) || isPathWithinDir(resolved, providerRoot)) {
    return resolved;
  }
  const error = new Error('path is not allowed') as Error & { code?: string };
  error.code = 'forbidden_path';
  throw error;
}

async function listRoutingSources(): Promise<RoutingSourceSummary[]> {
  const activePath = pickUserConfigPath();
  const routecodexHome = path.join(pickHomeDir(), '.routecodex');
  const providerRoot = pickProviderRootDir();

  const candidates: Array<{ kind: RoutingSourceSummary['kind']; label: string; path: string }> = [];
  candidates.push({ kind: 'active', label: 'Active config', path: activePath });

  const defaultConfig = path.join(routecodexHome, 'config.json');
  if (defaultConfig !== activePath) {
    candidates.push({ kind: 'routecodex', label: 'Default config.json', path: defaultConfig });
  }

  // Root-level config backups or variants (config_*.json)
  try {
    const entries = await fs.readdir(routecodexHome, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      const lower = name.toLowerCase();
      if (!lower.endsWith('.json')) continue;
      if (!lower.startsWith('config_')) continue;
      candidates.push({ kind: 'routecodex', label: name, path: path.join(routecodexHome, name) });
    }
  } catch {
    // ignore
  }

  // Imported configs under ~/.routecodex/config and ~/.routecodex/config/multi
  for (const dir of [path.join(routecodexHome, 'config'), path.join(routecodexHome, 'config', 'multi')]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const name = ent.name;
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (lower.endsWith('.ds_store')) continue;
        const label = dir.endsWith(path.join('config', 'multi')) ? `config/multi/${name}` : `config/${name}`;
        candidates.push({ kind: 'import', label, path: path.join(dir, name) });
      }
    } catch {
      // ignore
    }
  }

  // Provider directory v1 configs often carry their own virtualrouter.routing for standalone operation.
  try {
    const dirs = await fs.readdir(providerRoot, { withFileTypes: true });
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const providerId = ent.name;
      const providerDir = path.join(providerRoot, providerId);
      let files: string[] = [];
      try {
        files = (await fs.readdir(providerDir, { withFileTypes: true }))
          .filter((f) => f.isFile())
          .map((f) => f.name);
      } catch {
        files = [];
      }
      for (const name of files) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (!lower.includes('.v1.json') && lower !== 'config.codex.json') continue;
        candidates.push({ kind: 'provider', label: `provider/${providerId}/${name}`, path: path.join(providerDir, name) });
      }
    }
  } catch {
    // ignore
  }

  const out: RoutingSourceSummary[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const abs = path.resolve(candidate.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const allowed = resolveAllowedAdminFilePath(abs);
      const raw = await fs.readFile(allowed, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const snapshot = extractRoutingSnapshot(parsed);

      const hasRoutingContainer =
        snapshot.location === 'virtualrouter.routing'
          ? Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).virtualrouter)
          : Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
      if (!hasRoutingContainer) continue;

      out.push({
        id: abs,
        kind: candidate.kind,
        label: candidate.label,
        path: abs,
        location: snapshot.location,
        version: snapshot.version
      });
    } catch {
      // ignore parse/read errors
    }
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
  return out;
}

async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const backup = `${filePath}.${Date.now()}.bak`;
  try {
    await fs.copyFile(filePath, backup);
  } catch {
    return;
  }
}

function validateAndNormalizeProviderConfig(
  providerId: string,
  provider: Record<string, unknown>
): { ok: true; provider: Record<string, unknown> } | { ok: false; message: string } {
  const idNode = typeof provider.id === 'string' ? provider.id.trim() : '';
  if (idNode && idNode !== providerId) {
    return { ok: false, message: `provider.id must match providerId (${providerId})` };
  }
  const auth = provider.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { ok: false, message: 'provider.auth must be an object' };
  }
  const authRec = auth as Record<string, unknown>;
  const secretFields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret'];
  for (const field of secretFields) {
    if (typeof authRec[field] === 'string' && authRec[field].trim()) {
      return {
        ok: false,
        message: `provider.auth must not include inline secret field "${field}". Use secretRef (authfile-...) or tokenFile.`
      };
    }
  }

  const normalized: Record<string, unknown> = { ...provider };
  if (!idNode) {
    normalized.id = providerId;
  }
  return { ok: true, provider: normalized };
}
