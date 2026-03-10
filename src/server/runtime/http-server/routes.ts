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
import { registerSessionClientRoutes } from './session-client-routes.js';
import type { HistoricalPeriodsSnapshot, HistoricalStatsSnapshot, StatsSnapshot } from './stats-manager.js';
import { buildInfo } from '../../../build-info.js';
import { logProcessLifecycleSync } from '../../../utils/process-lifecycle-logger.js';
import { setShutdownCallerContext } from '../../../utils/shutdown-caller-context.js';
import { loadProviderConfigsV2 } from '../../../config/provider-v2-loader.js';

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
  getStatsSnapshot?: () => {
    session: StatsSnapshot;
    historical: HistoricalStatsSnapshot;
    periods?: HistoricalPeriodsSnapshot;
  };
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



type ModelListItem = {
  id: string;
  object: 'model';
  owned_by: string;
  [key: string]: unknown;
};

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
] as const;

const CODEX_RESPONSES_MODEL_PRESETS: Record<string, Record<string, unknown>> = {
  'gpt-5.4': {
    description: 'Latest frontier agentic coding model.',
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.98.0',
    supported_in_api: true,
    priority: 0
  },
  'gpt-5.3-codex': {
    description: 'Agentic coding model.',
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0
  },
  'gpt-5.2-codex': {
    description: 'Agentic coding model.',
    prefer_websockets: false,
    support_verbosity: false,
    apply_patch_tool_type: 'freeform',
    input_modalities: ['text', 'image'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    default_reasoning_summary: 'auto',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 3
  }
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveContextWindow(providerNode: Record<string, unknown>, modelNode: Record<string, unknown>): number | undefined {
  return readNumber(modelNode.maxContext)
    ?? readNumber(modelNode.maxContextTokens)
    ?? readNumber(modelNode.contextWindow)
    ?? readNumber(providerNode.maxContextTokens);
}

function buildCodexModelMetadata(
  providerId: string,
  modelId: string,
  aliasId: string,
  providerNode: Record<string, unknown>,
  modelNode: Record<string, unknown>
): ModelListItem {
  const preset = CODEX_RESPONSES_MODEL_PRESETS[modelId] ?? {};
  const contextWindow = resolveContextWindow(providerNode, modelNode);
  const supportsStreaming = readBoolean(modelNode.supportsStreaming);
  const item: ModelListItem = {
    id: aliasId,
    object: 'model',
    owned_by: providerId,
    slug: aliasId,
    display_name: aliasId,
    supported_in_api: true,
    visibility: 'list',
    priority: 0,
    input_modalities: ['text'],
    supports_parallel_tool_calls: true,
    prefer_websockets: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    default_reasoning_summary: 'auto',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    shell_type: 'shell_command',
    ...preset
  };
  if (contextWindow) {
    item.context_window = contextWindow;
  }
  if (supportsStreaming !== undefined) {
    item.supports_streaming = supportsStreaming;
  }
  const modelDescription = readString(modelNode.description);
  if (modelDescription) {
    item.description = modelDescription;
  }
  return item;
}

function collectArtifactModelAliases(artifacts: unknown): ModelListItem[] {
  const vrConfig = isPlainRecord(artifacts) ? (artifacts.config as Record<string, unknown> | undefined) : undefined;
  const providers = isPlainRecord(vrConfig) ? (vrConfig.providers as Record<string, unknown> | undefined) : undefined;
  const items: ModelListItem[] = [];
  if (!isPlainRecord(providers)) {
    return items;
  }
  for (const [providerKey, profileRaw] of Object.entries(providers)) {
    const profile = isPlainRecord(profileRaw) ? profileRaw : null;
    const runtimeKey = readString(profile?.runtimeKey) ?? '';
    const providerId =
      runtimeKey && runtimeKey.includes('.')
        ? runtimeKey.split('.')[0]
        : providerKey.includes('.')
          ? providerKey.split('.')[0]
          : '';
    const modelId = readString(profile?.modelId) ?? '';
    if (!providerId || !modelId) {
      continue;
    }
    items.push({ id: `${providerId}.${modelId}`, object: 'model', owned_by: providerId });
  }
  return items;
}

async function collectCodexModelItems(): Promise<ModelListItem[]> {
  const providerConfigs = await loadProviderConfigsV2();
  const items: ModelListItem[] = [];
  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    const providerNode = isPlainRecord(cfg.provider) ? cfg.provider : null;
    if (!providerNode) {
      continue;
    }
    if (readBoolean(providerNode.enabled) === false) {
      continue;
    }
    if (readString(providerNode.type) !== 'responses') {
      continue;
    }
    const modelsNode = isPlainRecord(providerNode.models) ? providerNode.models : null;
    if (!modelsNode) {
      continue;
    }
    for (const [modelId, modelRaw] of Object.entries(modelsNode)) {
      const trimmedModelId = modelId.trim();
      if (!trimmedModelId) {
        continue;
      }
      const modelNode = isPlainRecord(modelRaw) ? modelRaw : {};
      items.push(buildCodexModelMetadata(providerId, trimmedModelId, trimmedModelId, providerNode, modelNode));
      items.push(buildCodexModelMetadata(providerId, trimmedModelId, `${providerId}.${trimmedModelId}`, providerNode, modelNode));
    }
  }
  return items;
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

  // [RouteCodexHttpServer] Setting up routes

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

  const listModels = async (req: Request, res: Response) => {
    try {
      const items: ModelListItem[] = [];
      const seen = new Set<string>();
      for (const item of await collectCodexModelItems()) {
        if (seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        items.push(item);
      }
      const artifacts = typeof getVirtualRouterArtifacts === 'function' ? getVirtualRouterArtifacts() : null;
      for (const item of collectArtifactModelAliases(artifacts)) {
        if (seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        items.push(item);
      }
      items.sort((a, b) => a.id.localeCompare(b.id));
      const remoteIp = req.socket?.remoteAddress || '';
      const userAgent = req.get('user-agent') || '';
      const host = req.get('host') || '';
      const forwardedFor = req.get('x-forwarded-for') || '';
      const authPresent = Boolean(req.get('authorization') || req.get('x-api-key'));
      console.log(
        `[models] path=${req.path} count=${items.length} remoteIp=${remoteIp || 'n/a'} ` +
        `host=${host || 'n/a'} auth=${authPresent ? 'yes' : 'no'} ` +
        `xff=${forwardedFor || 'n/a'} ua=${userAgent || 'n/a'}`
      );
      res.status(200).json({ object: 'list', data: items });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[models] path=${req.path} failed error=${message}`);
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
          historical: { generatedAt: now, snapshotCount: 0, sampleCount: 0, totals: [] },
          periods: { generatedAt: now, daily: [], weekly: [], monthly: [] }
        };
    },
    restartRuntimeFromDisk: options.restartRuntimeFromDisk,
    getServerId: () =>
      (typeof options.getServerId === 'function'
        ? options.getServerId()
        : `${config.server.host}:${config.server.port}`),
    getServerHost: () => String(config.server.host || '')
  });

  // Session client daemon endpoints:
  // - loopback bind: localhost-only
  // - public bind: require httpserver.apikey
  registerSessionClientRoutes(app, {
    bindHost: config.server.host,
    expectedApiKey: config.server.apikey
  });

  // OAuth Portal route is registered early in constructor, so we skip it here
  // to avoid duplicate route registration

  app.post('/shutdown', (req: Request, res: Response) => {
    try {
      const ip = req.socket?.remoteAddress || '';
      const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      const shutdownAudit = {
        requestTs: new Date().toISOString(),
        remoteIp: ip,
        method: req.method,
        path: req.path,
        userAgent: req.get('user-agent') || '',
        forwardedFor: req.get('x-forwarded-for') || '',
        origin: req.get('origin') || '',
        referer: req.get('referer') || '',
        authPresent: Boolean(req.get('authorization') || req.get('x-api-key')),
        callerPid: (req.get('x-routecodex-stop-caller-pid') || '').slice(0, 64),
        callerTs: (req.get('x-routecodex-stop-caller-ts') || '').slice(0, 128),
        callerCwd: (req.get('x-routecodex-stop-caller-cwd') || '').slice(0, 512),
        callerCmd: (req.get('x-routecodex-stop-caller-cmd') || '').slice(0, 1024)
      };
      if (!allowed) {
        logProcessLifecycleSync({
          event: 'shutdown_route',
          source: 'http.routes.shutdown',
          details: { result: 'forbidden', ...shutdownAudit }
        });
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }

      setShutdownCallerContext({
        source: 'http.routes.shutdown',
        requestTs: shutdownAudit.requestTs,
        remoteIp: shutdownAudit.remoteIp,
        method: shutdownAudit.method,
        path: shutdownAudit.path,
        userAgent: shutdownAudit.userAgent,
        forwardedFor: shutdownAudit.forwardedFor,
        origin: shutdownAudit.origin,
        referer: shutdownAudit.referer,
        authPresent: shutdownAudit.authPresent,
        callerPid: shutdownAudit.callerPid,
        callerTs: shutdownAudit.callerTs,
        callerCwd: shutdownAudit.callerCwd,
        callerCmd: shutdownAudit.callerCmd
      });

      logProcessLifecycleSync({
        event: 'shutdown_route',
        source: 'http.routes.shutdown',
        details: { result: 'accepted', ...shutdownAudit }
      });
      res.status(200).json({ ok: true });
      setTimeout(() => {
        try {
          logProcessLifecycleSync({
            event: 'self_termination',
            source: 'http.routes.shutdown',
            details: {
              result: 'intent',
              reason: 'shutdown_route_requested',
              signal: 'SIGTERM',
              targetPid: process.pid,
              ...shutdownAudit
            }
          });
          logProcessLifecycleSync({
            event: 'kill_attempt',
            source: 'http.routes.shutdown',
            details: { targetPid: process.pid, signal: 'SIGTERM', result: 'attempt' }
          });
          process.kill(process.pid, 'SIGTERM');
        } catch (error) {
          logProcessLifecycleSync({
            event: 'kill_attempt',
            source: 'http.routes.shutdown',
            details: { targetPid: process.pid, signal: 'SIGTERM', result: 'failed', error }
          });
          return;
        }
      }, 50);
    } catch (error) {
      logProcessLifecycleSync({
        event: 'shutdown_route',
        source: 'http.routes.shutdown',
        details: { result: 'exception', requestTs: new Date().toISOString(), error }
      });
      try {
        res.status(200).json({ ok: true });
      } catch {
        // ignore secondary response errors
      }
      setTimeout(() => {
        try {
          logProcessLifecycleSync({
            event: 'self_termination',
            source: 'http.routes.shutdown',
            details: {
              result: 'intent',
              reason: 'shutdown_route_exception_fallback',
              signal: 'SIGTERM',
              targetPid: process.pid
            }
          });
          logProcessLifecycleSync({
            event: 'kill_attempt',
            source: 'http.routes.shutdown',
            details: { targetPid: process.pid, signal: 'SIGTERM', result: 'attempt' }
          });
          process.kill(process.pid, 'SIGTERM');
        } catch (innerError) {
          logProcessLifecycleSync({
            event: 'kill_attempt',
            source: 'http.routes.shutdown',
            details: { targetPid: process.pid, signal: 'SIGTERM', result: 'failed', error: innerError }
          });
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

  // [RouteCodexHttpServer] Routes setup completed
}
