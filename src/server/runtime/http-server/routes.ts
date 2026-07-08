// feature_id: server.models_capability_contract
import type { Application, Request, Response } from 'express';
import { handleChatCompletions } from '../../handlers/chat-handler.js';
import { handleImageEdits, handleImageGenerations } from '../../handlers/images-handler.js';
import { handleMessages } from '../../handlers/messages-handler.js';
import { handleResponses } from '../../handlers/responses-handler.js';
import type { HandlerContext } from '../../handlers/types.js';
import { resolveReportedRouteErrorHttpResponse } from '../../handlers/handler-utils.js';
import { isLocalRequest, registerDaemonAdminRoutes, rejectNonLocalOrUnauthorizedAdmin } from './daemon-admin-routes.js';
import type { ServerConfigV2 } from './types.js';
import type { HistoricalPeriodsSnapshot, HistoricalStatsSnapshot, StatsSnapshot } from './stats-manager.js';
import type { TokenStatsSnapshot } from './executor/token-stats-store.js';
import { buildInfo } from '../../../build-info.js';
import { logProcessLifecycleSync } from '../../../utils/process-lifecycle-logger.js';
import { setShutdownCallerContext } from '../../../utils/shutdown-caller-context.js';
import { loadProviderConfigsV2 } from '../../../config/provider-v2-loader.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import { runWithPortRequestContext } from './port-log-context.js';
import { readHubPipelineVirtualRouter } from './hub-pipeline-handle.js';

function logRoutesNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[http-routes] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function readVirtualRouterRuntimeStatus(hubPipeline: unknown): unknown | null {
  return readHubPipelineVirtualRouter(hubPipeline)?.getStatus() ?? null;
}

function readVirtualRouterRuntimeDryRun(
  hubPipeline: unknown,
  request: Record<string, unknown>,
  metadata: Record<string, unknown>
): unknown | null {
  return readHubPipelineVirtualRouter(hubPipeline)?.diagnoseRoute(request, metadata) ?? null;
}

interface RouteOptions {
  app: Application;
  config: ServerConfigV2;
  buildHandlerContext: (req: Request) => HandlerContext;
  getPipelineReady: () => boolean;
  waitForPipelineReady?: () => Promise<void>;
  handleError: (error: Error, context: string) => Promise<void>;
  getHealthSnapshot?: () => unknown | null;
  getRoutingState?: (sessionId: string) => unknown | null;
  getManagerDaemon?: () => unknown | null;
  getHubPipeline?: (routingPolicyGroup?: string) => unknown | null;
  getVirtualRouterArtifacts?: () => unknown | null;
  getUserConfig?: () => Record<string, unknown> | null;
  getServerId?: () => string;
  getServerHost?: () => string;
  getServerPort?: () => number | undefined;
  getStatsSnapshot?: () => {
    session: StatsSnapshot;
    historical: HistoricalStatsSnapshot;
    periods?: HistoricalPeriodsSnapshot;
    tokenStats: TokenStatsSnapshot;
  };
  restartRuntimeFromDisk?: () => Promise<{
    reloadedAt: number;
    configPath: string;
    warnings?: string[];
  }>;
  getPortRegistry?: () => unknown | null;
  getPortConfigs?: () => Array<Record<string, unknown>>;
  applyPortConfig?: (
    action: 'add' | 'update' | 'remove',
    port: number,
    config?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  getAvailableProviders?: () => Array<{ key: string; family?: string; protocol?: string }>;
}

function resolvePortScopedHubPipeline(req: Request, options: RouteOptions): unknown | null {
  return resolvePortScopedHubPipelineContext(req, options).hubPipeline;
}

function resolvePortScopedHubPipelineContext(req: Request, options: RouteOptions): {
  hubPipeline: unknown | null;
  localPort?: number;
  routingPolicyGroup?: string;
} {
  const getHubPipeline = typeof options.getHubPipeline === 'function' ? options.getHubPipeline : undefined;
  if (!getHubPipeline) {
    return { hubPipeline: null };
  }
  const localPort = typeof req.socket?.localPort === 'number' ? req.socket.localPort : undefined;
  const getPortConfigs = typeof options.getPortConfigs === 'function' ? options.getPortConfigs : undefined;
  if (!getPortConfigs || typeof localPort !== 'number') {
    return { hubPipeline: getHubPipeline(), localPort };
  }
  const portConfigs = getPortConfigs();
  const matchedPort = Array.isArray(portConfigs)
    ? portConfigs.find((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return typeof record.port === 'number' && record.port === localPort;
    })
    : undefined;
  const routingPolicyGroup =
    matchedPort
    && typeof (matchedPort as Record<string, unknown>).routingPolicyGroup === 'string'
      ? String((matchedPort as Record<string, unknown>).routingPolicyGroup).trim()
      : '';
  return {
    hubPipeline: routingPolicyGroup ? getHubPipeline(routingPolicyGroup) : getHubPipeline(),
    localPort,
    routingPolicyGroup: routingPolicyGroup || undefined
  };
}

type ModelListItem = {
  id: string;
  object: 'model';
  owned_by: string;
  [key: string]: unknown;
};

type ModelsListResponse = {
  object: 'list';
  data: ModelListItem[];
  models: ModelListItem[];
};

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
] as const;

const CODEX_ADVANCED_MODEL_METADATA: Record<string, unknown> = {
  description: 'RouteCodex advanced agentic coding model compatible with gpt-5.5 capabilities.',
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  supports_search_tool: true,
  input_modalities: ['text', 'image'],
  supports_image_detail_original: true,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  reasoning_summary_format: 'experimental',
  supports_reasoning_summaries: true,
  default_reasoning_summary: 'none',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
  shell_type: 'shell_command',
  visibility: 'list',
  minimal_client_version: '0.98.0',
  supported_in_api: true,
  priority: 0,
  experimental_supported_tools: ['apply_patch', 'web_search'],
  effective_context_window_percent: 95
};

const CODEX_RESPONSES_MODEL_PRESETS: Record<string, Record<string, unknown>> = {
  'gpt-5.5': {
    ...CODEX_ADVANCED_MODEL_METADATA,
    description: 'Frontier model for complex coding, research, and real-world work.',
    prefer_websockets: true,
    minimal_client_version: '0.124.0',
    context_window: 272000,
    max_context_window: 272000
  },
  'gpt-5.4': {
    ...CODEX_ADVANCED_MODEL_METADATA,
    description: 'Latest frontier agentic coding model.'
  },
  'gpt-5.3-codex': {
    ...CODEX_ADVANCED_MODEL_METADATA,
    description: 'Agentic coding model.'
  },
  'gpt-5.2-codex': {
    ...CODEX_ADVANCED_MODEL_METADATA,
    description: 'Agentic coding model.',
    support_verbosity: false,
    supports_image_detail_original: false,
    default_reasoning_summary: 'auto',
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
  const preset = CODEX_RESPONSES_MODEL_PRESETS[modelId] ?? CODEX_ADVANCED_MODEL_METADATA;
  const contextWindow = resolveContextWindow(providerNode, modelNode);
  const supportsStreaming = readBoolean(modelNode.supportsStreaming);
  const item: ModelListItem = {
    id: aliasId,
    object: 'model',
    owned_by: providerId,
    slug: aliasId,
    display_name: aliasId,
    base_instructions: '',
    supported_in_api: true,
    visibility: 'list',
    priority: 0,
    ...preset
  };
  if (contextWindow) {
    item.context_window = contextWindow;
    item.max_context_window = contextWindow;
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

function buildCodexAdvancedModelMetadata(): ModelListItem {
  return buildCodexModelMetadata('openai', 'gpt-5.5', 'gpt-5.5', {}, {});
}

function buildModelsListResponse(items: ModelListItem[]): ModelsListResponse {
  return {
    object: 'list',
    data: items,
    models: items
  };
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

async function collectConfiguredModelItems(): Promise<ModelListItem[]> {
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
    const modelsNode = isPlainRecord(providerNode.models) ? providerNode.models : null;
    if (!modelsNode) {
      continue;
    }
    const providerType = readString(providerNode.type);
    for (const [modelId, modelRaw] of Object.entries(modelsNode)) {
      const trimmedModelId = modelId.trim();
      if (!trimmedModelId) {
        continue;
      }
      const modelNode = isPlainRecord(modelRaw) ? modelRaw : {};
      if (providerType === 'responses') {
        items.push(buildCodexModelMetadata(providerId, trimmedModelId, trimmedModelId, providerNode, modelNode));
      }
      items.push(buildCodexModelMetadata(providerId, trimmedModelId, `${providerId}.${trimmedModelId}`, providerNode, modelNode));
    }
  }
  return items;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function readModelDisplayAlias(modelNode: Record<string, unknown>): string | undefined {
  const aliases = readStringArray(modelNode.aliases);
  return aliases[0];
}

function collectPortVisibleModelRefs(args: {
  userConfig: Record<string, unknown>;
  routingPolicyGroup: string;
}): Array<{ providerId: string; modelId: string }> {
  const vrNode = isRecord(args.userConfig.virtualrouter) ? args.userConfig.virtualrouter : null;
  const groupsNode = vrNode && isRecord(vrNode.routingPolicyGroups) ? vrNode.routingPolicyGroups : null;
  const groupNode = groupsNode && isRecord(groupsNode[args.routingPolicyGroup]) ? groupsNode[args.routingPolicyGroup] : null;
  const routingNode = groupNode && isRecord((groupNode as Record<string, unknown>).routing)
    ? ((groupNode as Record<string, unknown>).routing as Record<string, unknown>)
    : null;
  const forwardersNode = vrNode && isRecord(vrNode.forwarders) ? vrNode.forwarders : null;
  const out: Array<{ providerId: string; modelId: string }> = [];
  const seen = new Set<string>();

  const pushRef = (providerId: string, modelId: string) => {
    const pid = providerId.trim();
    const mid = modelId.trim();
    if (!pid || !mid) {
      return;
    }
    const key = `${pid}::${mid}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ providerId: pid, modelId: mid });
  };

  const collectFromTarget = (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.startsWith('fwd.') && forwardersNode && isRecord(forwardersNode[trimmed])) {
      const forwarder = forwardersNode[trimmed] as Record<string, unknown>;
      const targets = Array.isArray(forwarder.targets) ? forwarder.targets : [];
      for (const targetNode of targets) {
        if (!isRecord(targetNode)) {
          continue;
        }
        const providerId = typeof targetNode.providerId === 'string' ? targetNode.providerId : '';
        const modelId = typeof targetNode.modelId === 'string'
          ? targetNode.modelId
          : (typeof targetNode.model === 'string' ? targetNode.model : '');
        pushRef(providerId, modelId);
      }
      return;
    }
    const parts = trimmed.split('.').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      return;
    }
    pushRef(parts[0], parts.length >= 3 ? parts.slice(2).join('.') : parts.slice(1).join('.'));
  };

  if (!routingNode) {
    return out;
  }
  for (const routeEntry of Object.values(routingNode)) {
    const pools = Array.isArray(routeEntry) ? routeEntry : [routeEntry];
    for (const pool of pools) {
      if (!isRecord(pool)) {
        continue;
      }
      for (const target of readStringArray(pool.targets)) {
        collectFromTarget(target);
      }
      if (typeof pool.target === 'string') {
        collectFromTarget(pool.target);
      }
    }
  }
  return out;
}

async function collectPortScopedModelItems(args: {
  userConfig: Record<string, unknown>;
  routingPolicyGroup: string;
}): Promise<ModelListItem[]> {
  const providerConfigs = await loadProviderConfigsV2();
  const refs = collectPortVisibleModelRefs(args);
  const items: ModelListItem[] = [];
  for (const ref of refs) {
    const cfg = providerConfigs[ref.providerId];
    const providerNode = isRecord(cfg?.provider) ? cfg.provider : null;
    if (!providerNode || readBoolean(providerNode.enabled) === false) {
      continue;
    }
    const modelsNode = isRecord(providerNode.models) ? providerNode.models : null;
    const modelNode = modelsNode && isRecord(modelsNode[ref.modelId])
      ? (modelsNode[ref.modelId] as Record<string, unknown>)
      : {};
    const aliasId = readModelDisplayAlias(modelNode) ?? ref.modelId;
    items.push(buildCodexModelMetadata(ref.providerId, ref.modelId, aliasId, providerNode, modelNode));
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

  app.get('/_routecodex/diagnostics/virtual-router', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    try {
      const { hubPipeline, localPort, routingPolicyGroup } = resolvePortScopedHubPipelineContext(req, options);
      const virtualRouter = readVirtualRouterRuntimeStatus(hubPipeline);
      res.status(200).json({
        ok: true,
        serverId: typeof options.getServerId === 'function' ? options.getServerId() : `${config.server.host}:${config.server.port}`,
        localPort,
        routingPolicyGroup,
        virtualRouter
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'virtual_router_diagnostics_failed' } });
    }
  });

  app.get('/_routecodex/diagnostics/virtual-router/status', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    try {
      const { hubPipeline, localPort, routingPolicyGroup } = resolvePortScopedHubPipelineContext(req, options);
      const virtualRouter = readVirtualRouterRuntimeStatus(hubPipeline);
      res.status(200).json({
        ok: true,
        serverId: typeof options.getServerId === 'function' ? options.getServerId() : `${config.server.host}:${config.server.port}`,
        localPort,
        routingPolicyGroup,
        virtualRouter
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'virtual_router_diagnostics_failed' } });
    }
  });

  app.post('/_routecodex/diagnostics/virtual-router/dry-run', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body as Record<string, unknown> : null;
      const request = body && isRecord(body.request) ? body.request as Record<string, unknown> : null;
      const metadata = body && isRecord(body.metadata) ? body.metadata as Record<string, unknown> : null;
      if (!request || !metadata) {
        res.status(400).json({
          error: {
            message: 'request and metadata are required',
            code: 'bad_request'
          }
        });
        return;
      }
      const { hubPipeline, localPort, routingPolicyGroup } = resolvePortScopedHubPipelineContext(req, options);
      const diagnostics = readVirtualRouterRuntimeDryRun(hubPipeline, request, metadata);
      if (!diagnostics) {
        res.status(500).json({
          error: {
            message: 'VirtualRouter.diagnoseRoute is not available',
            code: 'virtual_router_dry_run_unavailable'
          }
        });
        return;
      }
      res.status(200).json({
        ok: true,
        serverId: typeof options.getServerId === 'function' ? options.getServerId() : `${config.server.host}:${config.server.port}`,
        localPort,
        routingPolicyGroup,
        diagnostics
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'virtual_router_dry_run_failed' } });
    }
  });

  const listModels = async (req: Request, res: Response) => {
    try {
      const items: ModelListItem[] = [];
      const seen = new Set<string>();
      const codexAdvancedModel = buildCodexAdvancedModelMetadata();
      seen.add(codexAdvancedModel.id);
      items.push(codexAdvancedModel);
      const localPort = typeof req.socket?.localPort === 'number' ? req.socket.localPort : undefined;
      const portConfigs = typeof options.getPortConfigs === 'function' ? options.getPortConfigs() : [];
      const localMatchedPort = typeof localPort === 'number' && Array.isArray(portConfigs)
        ? portConfigs.find((entry) => isRecord(entry) && entry.port === localPort)
        : undefined;
      const configuredMatchedPort = Array.isArray(portConfigs) && typeof config?.server?.port === 'number'
          ? portConfigs.find((entry) => isRecord(entry) && entry.port === config.server.port)
          : undefined;
      const matchedPort = localMatchedPort ?? configuredMatchedPort;
      const routingPolicyGroup = matchedPort && typeof matchedPort.routingPolicyGroup === 'string'
        ? matchedPort.routingPolicyGroup.trim()
        : '';
      const artifacts = typeof getVirtualRouterArtifacts === 'function' ? getVirtualRouterArtifacts() : null;
      const optionUserConfig = typeof options.getUserConfig === 'function' ? options.getUserConfig() : null;
      const userConfig = isPlainRecord(artifacts) && isPlainRecord((artifacts as Record<string, unknown>).userConfig)
        ? ((artifacts as Record<string, unknown>).userConfig as Record<string, unknown>)
        : (isPlainRecord(optionUserConfig)
            ? optionUserConfig
            : {});
      const configuredItems = routingPolicyGroup
        ? await collectPortScopedModelItems({
            userConfig,
            routingPolicyGroup
          })
        : await collectConfiguredModelItems();
      for (const item of configuredItems) {
        if (seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        items.push(item);
      }
      if (!routingPolicyGroup) {
        for (const item of collectArtifactModelAliases(artifacts)) {
          if (seen.has(item.id)) {
            continue;
          }
          seen.add(item.id);
          items.push(item);
        }
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
      res.status(200).json(buildModelsListResponse(items));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[models] path=${req.path} failed error=${message}`);
      res.status(500).json({ error: { message, code: 'internal_error' } });
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
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.get('/manager/state/routing/:sessionId', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: { message: 'sessionId is required' , code: 'bad_request' } });
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
      res.status(500).json({ error: { message, code: 'internal_error' } });
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
          periods: { generatedAt: now, daily: [], weekly: [], monthly: [] },
          tokenStats: {
            alltime: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
            daily: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
            dailyDate: [
              new Date(now).getFullYear(),
              String(new Date(now).getMonth() + 1).padStart(2, '0'),
              String(new Date(now).getDate()).padStart(2, '0')
            ].join('-'),
            providers: []
          }
        };
      },
    restartRuntimeFromDisk: options.restartRuntimeFromDisk,
    getPortRegistry: typeof options.getPortRegistry === 'function' ? options.getPortRegistry as any : undefined,
    getPortConfigs: typeof options.getPortConfigs === 'function' ? options.getPortConfigs as any : undefined,
    applyPortConfig: typeof options.applyPortConfig === 'function' ? options.applyPortConfig as any : undefined,
    getAvailableProviders: typeof options.getAvailableProviders === 'function' ? options.getAvailableProviders : undefined,
    getServerId: () =>
      (typeof options.getServerId === 'function'
        ? options.getServerId()
        : `${config.server.host}:${config.server.port}`),
    getServerHost: () => String(config.server.host || ''),
    getServerPort: () => (typeof config?.server?.port === 'number' ? config.server.port : undefined)
  });

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
        res.status(403).json({ error: { message: 'forbidden' , code: 'forbidden' } });
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
      } catch (responseError) {
        logRoutesNonBlockingError('shutdownRoute.sendAckOnException', responseError, {
          path: req.path,
          method: req.method
        });
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
      res.status(500).json({ error: { message, code: 'internal_error' } });
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

  // Wrap an async handler so any thrown error is converted to a JSON HTTP response.
  // Without this, an unhandled rejection inside an async route causes Express
  // to reset the connection (Empty reply from server) instead of returning a
  // proper JSON error body. Hard guard: every route handler must use this wrapper.
  const wrap = (label: string, handler: (req: Request, res: Response) => Promise<unknown>) => {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const errorRecord = normalized as unknown as Record<string, unknown>;
        const explicitStatus =
          typeof errorRecord.status === 'number' ? errorRecord.status :
          typeof errorRecord.statusCode === 'number' ? errorRecord.statusCode :
          500;
        const code =
          typeof errorRecord.code === 'string' && errorRecord.code.trim()
            ? String(errorRecord.code)
            : 'internal_error';
        const portTag = (() => {
          const port = errorRecord.port;
          if (typeof port === 'number') return String(port);
          return '-';
        })();
        logRoutesNonBlockingError(`route.${label}.unhandled`, error, {
          port: portTag,
          method: req.method,
          path: req.path
        });
        if (res.headersSent) {
          try { res.end(); } catch { /* ignore */ }
          return;
        }
        res.status(explicitStatus).json({
          error: {
            message: normalized.message,
            type: 'route_handler_error',
            code,
            port: portTag,
            entryEndpoint: label
          }
        });
      }
    };
  };

  app.post('/v1/chat/completions', wrap('/v1/chat/completions', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    const ctx = buildHandlerContext(req);
    await runWithPortRequestContext(ctx.portContext, () => handleChatCompletions(req, res, ctx));
  }));
  app.post('/v1/images/generations', wrap('/v1/images/generations', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleImageGenerations(req, res, buildHandlerContext(req));
  }));
  app.post('/v1/images/edits', wrap('/v1/images/edits', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    await handleImageEdits(req, res, buildHandlerContext(req));
  }));
  app.post('/v1/messages', wrap('/v1/messages', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    const ctx = buildHandlerContext(req);
    await runWithPortRequestContext(ctx.portContext, () => handleMessages(req, res, ctx));
  }));
  app.post('/v1/responses', wrap('/v1/responses', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    const ctx = buildHandlerContext(req);
    await runWithPortRequestContext(ctx.portContext, () => handleResponses(req, res, ctx));
  }));
  app.post('/v1/responses/:id/submit_tool_outputs', wrap('/v1/responses.submit_tool_outputs', async (req, res) => {
    if (!(await holdUntilReady(res))) {return;}
    const ctx = buildHandlerContext(req);
    await runWithPortRequestContext(ctx.portContext, () => handleResponses(req, res, ctx, {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      responseIdFromPath: req.params?.id
    }));
  }));

  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: 'Not Found',
        type: 'not_found_error',
        code: 'not_found'
      }
    });
  });

  app.use(async (error: unknown, req: Request, res: Response, _next: unknown) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const errorRecord = normalizedError as unknown as Record<string, unknown>;
    const httpStatus =
      typeof errorRecord.status === 'number'
        ? errorRecord.status
        : typeof errorRecord.statusCode === 'number'
          ? errorRecord.statusCode
          : undefined;
    const isMalformedJsonRequest =
      httpStatus === 400
      && normalizedError.name === 'SyntaxError';
    const mapped = await resolveReportedRouteErrorHttpResponse({
      routePayload: {
        code: isMalformedJsonRequest
          ? 'MALFORMED_REQUEST'
          : typeof errorRecord.code === 'string'
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
          status: httpStatus
        },
        originalError: normalizedError
      },
      normalizedError: normalizedError as Error & Record<string, unknown>,
      onReportError: (hubError) => {
        logRoutesNonBlockingError('globalMiddleware.reportRouteError', hubError, {
          requestId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
          path: req.path,
          method: req.method
        });
      }
    });
    res.status(mapped.status).json(mapped.body);
  });

  // [RouteCodexHttpServer] Routes setup completed
}
