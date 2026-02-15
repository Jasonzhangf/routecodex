import type { Application, Request, Response } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import type { VirtualRouterArtifacts, ProviderProtocol } from '../types.js';
import { loadProviderConfigsV2 } from '../../../../config/provider-v2-loader.js';
import type { ProviderConfigV2 } from '../../../../config/provider-v2-loader.js';
import {
  applyProviderDeleteV1,
  applyProviderUpsertV1,
  extractCredentialsRef,
  extractDefaultModels,
  extractProvidersV1,
  scrubProviderConfig,
  scrubProviderConfigV1,
  summarizeProviderV1,
  validateAndNormalizeProviderConfig,
  validateAndNormalizeProviderConfigV1
} from './providers-handler-utils.js';
import {
  applyRoutingAtLocation,
  backupFile,
  extractRoutingSnapshot,
  listRoutingSources,
  pickProviderRootDir,
  pickUserConfigPath,
  readQueryString,
  resolveAllowedAdminFilePath,
  type RoutingLocation
} from './providers-handler-routing-utils.js';

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
    const loadBalancingNode = body?.loadBalancing;
    const locationNode = body?.location;
    if (!routingNode || typeof routingNode !== 'object' || Array.isArray(routingNode)) {
      res.status(400).json({ error: { message: 'routing must be an object', code: 'bad_request' } });
      return;
    }
    if (
      loadBalancingNode !== undefined
      && loadBalancingNode !== null
      && (typeof loadBalancingNode !== 'object' || Array.isArray(loadBalancingNode))
    ) {
      res.status(400).json({ error: { message: 'loadBalancing must be an object or null', code: 'bad_request' } });
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
      const shouldApplyLoadBalancing = loadBalancingNode !== undefined;
      const next = applyRoutingAtLocation(
        parsed,
        routingNode as Record<string, unknown>,
        location,
        {
          applyLoadBalancing: shouldApplyLoadBalancing,
          loadBalancing: shouldApplyLoadBalancing
            ? (loadBalancingNode === null ? null : (loadBalancingNode as Record<string, unknown>))
            : undefined
        }
      );
      await backupFile(configPath);
      await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf8');
      const snapshot = extractRoutingSnapshot(next);
      res.status(200).json({
        ok: true,
        path: configPath,
        location: snapshot.location,
        routing: snapshot.routing,
        loadBalancing: snapshot.loadBalancing,
        hasLoadBalancing: snapshot.hasLoadBalancing
      });
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
