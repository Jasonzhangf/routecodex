import type { Application, Request, Response } from 'express';
import { handleChatCompletions } from '../../handlers/chat-handler.js';
import { handleMessages } from '../../handlers/messages-handler.js';
import { handleResponses } from '../../handlers/responses-handler.js';
import type { HandlerContext } from '../../handlers/types.js';
import type { ServerConfigV2 } from './types.js';
import { reportRouteError } from '../../../error-handling/route-error-hub.js';
import { mapErrorToHttp } from '../../utils/http-error-mapper.js';
import { renderTokenPortalPage } from '../../../token-portal/render.js';
import { loadTokenPortalFingerprintSummary } from '../../../token-portal/fingerprint-summary.js';
import { registerDaemonAdminRoutes, rejectNonLocalOrUnauthorizedAdmin } from './daemon-admin-routes.js';
import type { HistoricalStatsSnapshot, StatsSnapshot } from './stats-manager.js';
import { buildInfo } from '../../../build-info.js';

interface RouteOptions {
  app: Application;
  config: ServerConfigV2;
  buildHandlerContext: () => HandlerContext;
  getPipelineReady: () => boolean;
  waitForPipelineReady?: () => Promise<void>;
  handleError: (error: Error, context: string) => Promise<void>;
  getHealthSnapshot?: () => unknown | null;
  getRoutingState?: (sessionId: string) => unknown | null;
  getManagerDaemon?: () => unknown | null;
  getVirtualRouterArtifacts?: () => unknown | null;
  getServerId?: () => string;
  getStatsSnapshot?: () => { session: StatsSnapshot; historical: HistoricalStatsSnapshot };
  restartRuntimeFromDisk?: () => Promise<{
    reloadedAt: number;
    configPath: string;
    warnings?: string[];
  }>;
}

/**
 * Register OAuth Portal route early to support token authentication flow
 * This route must be available before provider initialization
 */
export function registerOAuthPortalRoute(app: Application): void {
  app.get('/token-auth/demo', async (req: Request, res: Response) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : 'unknown-provider';
    const alias = typeof req.query.alias === 'string' ? req.query.alias : 'default';
    const tokenFile =
      typeof req.query.tokenFile === 'string' ? req.query.tokenFile : '~/.routecodex/auth/unknown-token.json';
    const oauthUrl =
      typeof req.query.oauthUrl === 'string'
        ? req.query.oauthUrl
        : 'https://accounts.google.com/o/oauth2/v2/auth';
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : 'demo-session';
    const displayName =
      typeof req.query.displayName === 'string' && req.query.displayName.trim() ? req.query.displayName : undefined;
    const fingerprint = await loadTokenPortalFingerprintSummary(provider, alias).catch(() => null);
    const html = renderTokenPortalPage({
      provider,
      alias,
      tokenFile,
      oauthUrl,
      sessionId,
      displayName,
      fingerprint: fingerprint || undefined
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

export function registerHttpRoutes(options: RouteOptions): void {
  const {
    app,
    config,
    buildHandlerContext,
    getPipelineReady,
    waitForPipelineReady,
    getHealthSnapshot,
    getRoutingState,
    getVirtualRouterArtifacts
  } = options;

  console.log('[RouteCodexHttpServer] Setting up routes...');

  app.get('/health', (_req: Request, res: Response) => {
    const ready = typeof getPipelineReady === 'function' ? Boolean(getPipelineReady()) : false;
    res.status(200).json({
      status: ready ? 'ok' : 'starting',
      ready,
      pipelineReady: ready,
      server: 'routecodex',
      version: buildInfo?.version ? String(buildInfo.version) : String(process.env.ROUTECODEX_VERSION || 'dev')
    });
  });

  app.get('/config', (_req: Request, res: Response) => {
    res.status(200).json({ httpserver: { host: config.server.host, port: config.server.port }, merged: false });
  });

  const listModels = (_req: Request, res: Response) => {
    try {
      const artifacts = typeof getVirtualRouterArtifacts === 'function' ? getVirtualRouterArtifacts() : null;
      const vrConfig = (artifacts as Record<string, unknown> | null)?.config as Record<string, unknown> | null;
      const providers = vrConfig && typeof vrConfig === 'object' ? (vrConfig as Record<string, unknown>).providers : null;
      const items: Array<{ id: string; object: 'model'; owned_by: string }> = [];
      const seen = new Set<string>();
      if (providers && typeof providers === 'object') {
        for (const [providerKey, profileRaw] of Object.entries(providers as Record<string, unknown>)) {
          const profile =
            profileRaw && typeof profileRaw === 'object' && !Array.isArray(profileRaw)
              ? (profileRaw as Record<string, unknown>)
              : null;
          const runtimeKey = typeof profile?.runtimeKey === 'string' ? String(profile.runtimeKey) : '';
          const providerId =
            runtimeKey && runtimeKey.includes('.')
              ? runtimeKey.split('.')[0]
              : typeof providerKey === 'string' && providerKey.includes('.')
              ? providerKey.split('.')[0]
              : '';
          const modelId = typeof profile?.modelId === 'string' ? String(profile.modelId) : '';
          if (!providerId || !modelId) {
            continue;
          }
          const id = `${providerId}.${modelId}`;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          items.push({ id, object: 'model', owned_by: providerId });
        }
      }
      items.sort((a, b) => a.id.localeCompare(b.id));
      res.status(200).json({ object: 'list', data: items });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  };

  // Standard model discovery: returns provider-prefixed models (provider.model).
  app.get('/models', listModels);
  app.get('/v1/models', listModels);

  app.get('/manager/state/health', (req: Request, res: Response) => {
    try {
      if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
      const snapshot = typeof getHealthSnapshot === 'function' ? getHealthSnapshot() : null;
      res.status(200).json({
        ok: true,
        snapshot
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/manager/state/routing/:sessionId', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: { message: 'sessionId is required' } });
      return;
    }
    try {
      const state = typeof getRoutingState === 'function' ? getRoutingState(sessionId) : null;
      res.status(200).json({
        ok: true,
        sessionId,
        state
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  // Daemon / token / quota / providers 管理类只读 API
  // - 默认仅本地访问
  // - 配置了 httpserver.apikey 后允许远程访问（需提供 apikey）
  registerDaemonAdminRoutes({
    app,
    getManagerDaemon: () =>
      (typeof options.getManagerDaemon === 'function' ? (options.getManagerDaemon() as unknown) : null),
    getVirtualRouterArtifacts: () =>
      (typeof options.getVirtualRouterArtifacts === 'function'
        ? options.getVirtualRouterArtifacts()
        : null),
    getConfigPath: () => (typeof config?.configPath === 'string' && config.configPath.trim() ? config.configPath : null),
    getExpectedApiKey: () => config?.server?.apikey,
    getStatsSnapshot: () => {
      const now = Date.now();
      return typeof options.getStatsSnapshot === 'function'
        ? options.getStatsSnapshot()
        : {
          session: { generatedAt: now, uptimeMs: 0, totals: [] },
          historical: { generatedAt: now, snapshotCount: 0, sampleCount: 0, totals: [] }
        };
    },
    restartRuntimeFromDisk: options.restartRuntimeFromDisk,
    getServerId: () =>
      (typeof options.getServerId === 'function'
        ? options.getServerId()
        : `${config.server.host}:${config.server.port}`)
  });

  // OAuth Portal route is registered early in constructor, so we skip it here
  // to avoid duplicate route registration

  app.post('/shutdown', (req: Request, res: Response) => {
    try {
      const ip = req.socket?.remoteAddress || '';
      const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!allowed) {
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }
      res.status(200).json({ ok: true });
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          return;
        }
      }, 50);
    } catch {
      try {
        res.status(200).json({ ok: true });
      } catch {
        // ignore secondary response errors
      }
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          return;
        }
      }, 50);
    }
  });

  app.get('/debug/runtime', (_req: Request, res: Response) => {
    try {
      res.status(200).json({ pipelineReady: getPipelineReady() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  const holdUntilReady = async (res: Response): Promise<boolean> => {
    if (typeof waitForPipelineReady !== 'function') {
      return true;
    }
    try {
      await waitForPipelineReady();
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(503).json({
        error: {
          message: `Server is still starting: ${message}`,
          type: 'server_starting',
          code: 'server_starting'
        }
      });
      return false;
    }
  };

  app.post('/v1/chat/completions', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleChatCompletions(req, res, buildHandlerContext());
  });
  app.post('/v1/messages', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleMessages(req, res, buildHandlerContext());
  });
  app.post('/v1/responses', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleResponses(req, res, buildHandlerContext());
  });
  app.post('/v1/responses/:id/submit_tool_outputs', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleResponses(req, res, buildHandlerContext(), {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      responseIdFromPath: req.params?.id
    });
  });

  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: 'Not Found',
        type: 'not_found_error',
        code: 'not_found'
      }
    });
  });

  app.use(async (error: unknown, req: Request, res: Response) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const errorRecord = normalizedError as unknown as Record<string, unknown>;
    let mapped = mapErrorToHttp(normalizedError);
    try {
      const { http } = await reportRouteError({
        code: typeof errorRecord.code === 'string'
          ? String(errorRecord.code)
          : 'HTTP_MIDDLEWARE_ERROR',
        message: normalizedError.message,
        source: 'http-middleware.global',
        scope: 'http',
        severity: 'high',
        endpoint: req.path,
        requestId: typeof req.headers['x-request-id'] === 'string'
          ? req.headers['x-request-id']
          : undefined,
        details: {
          method: req.method,
          statusOverride: (error as { status?: number })?.status
        },
        originalError: normalizedError
      }, { includeHttpResult: true });
      if (http) {
        mapped = http;
      }
    } catch {
      /* ignore hub failures */
    }
    res.status(mapped.status).json(mapped.body);
  });

  console.log('[RouteCodexHttpServer] Routes setup completed');
}
