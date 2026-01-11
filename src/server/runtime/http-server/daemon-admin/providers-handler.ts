import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { isLocalRequest } from '../daemon-admin-routes.js';
import type { VirtualRouterArtifacts, ProviderProtocol } from '../types.js';
import { loadProviderConfigsV2 } from '../../../../config/provider-v2-loader.js';
import type { ProviderConfigV2 } from '../../../../config/provider-v2-loader.js';

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
  app.get('/providers/runtimes', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
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

  // Config V2 Provider 视图：基于 ~/.routecodex/provider/*/config.v2.json 的声明性配置。
  app.get('/config/providers/v2', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
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
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
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
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
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
