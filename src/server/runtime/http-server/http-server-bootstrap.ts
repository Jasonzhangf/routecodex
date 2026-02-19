import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { DebugCenter } from '../../../modules/pipeline/types/external-types.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderProfile, ProviderProfileCollection } from '../../../providers/profile/provider-profile.js';
import { buildProviderProfiles } from '../../../providers/profile/provider-profile-loader.js';
import { logPipelineStage } from '../../utils/stage-logger.js';
import { buildInfo } from '../../../build-info.js';
import {
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor
} from '../../../modules/llmswitch/bridge.js';
import type { HubPipeline, HubPipelineCtor, VirtualRouterArtifacts } from './types.js';
import { resolveProviderIdentity } from './provider-utils.js';
import { initializeRouteErrorHub as initializeRouteErrorHubImpl } from '../../../error-handling/route-error-hub.js';
import { formatErrorForErrorCenter } from '../../../utils/error-center-payload.js';

export function resolveVirtualRouterInput(server: any, userConfig: UnknownObject): UnknownObject {
  if (userConfig?.virtualrouter && typeof userConfig.virtualrouter === 'object') {
    return userConfig.virtualrouter as UnknownObject;
  }
  return userConfig;
}

export function getModuleDependencies(server: any): ModuleDependencies {
  if (!server.moduleDependencies) {
    server.moduleDependencies = {
      errorHandlingCenter: server.getErrorHandlingShim(),
      debugCenter: server.createDebugCenterShim(),
      logger: server.pipelineLogger
    };
  }
  return server.moduleDependencies;
}

export function registerDaemonAdminUiRoute(server: any): void {
  server.app.get(['/daemon/admin', '/daemon/admin/'], async (_req: unknown, res: any) => {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const builtIndex = path.join(process.cwd(), 'dist', 'daemon-admin-ui', 'index.html');
      const legacyFile = path.join(process.cwd(), 'docs', 'daemon-admin-ui.html');
      let html = '';
      try {
        html = await fs.readFile(builtIndex, 'utf8');
      } catch {
        try {
          const filePath = new URL('../../../../docs/daemon-admin-ui.html', import.meta.url);
          html = await fs.readFile(filePath, 'utf8');
        } catch {
          html = await fs.readFile(legacyFile, 'utf8');
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader(
        'X-RouteCodex-Version',
        buildInfo?.version ? String(buildInfo.version) : String(process.env.ROUTECODEX_VERSION || 'dev')
      );
      res.send(html);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: {
          message: `Daemon admin UI not available: ${message}`
        }
      });
    }
  });

  server.app.get('/daemon/admin/*', async (req: any, res: any, next: any) => {
    try {
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const root = path.join(process.cwd(), 'dist', 'daemon-admin-ui');
      const relPath = String(req.path || '').replace(/^\/daemon\/admin\/?/, '').trim();
      if (!relPath) {
        next();
        return;
      }
      const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const target = path.join(root, normalized);
      if (!target.startsWith(root)) {
        res.status(404).end();
        return;
      }
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) {
        next();
        return;
      }
      const ext = path.extname(target).toLowerCase();
      if (ext === '.js') {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (ext === '.css') {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.sendFile(target);
    } catch {
      next();
    }
  });
}

export function getErrorHandlingShim(server: any): ModuleDependencies['errorHandlingCenter'] {
  if (!server.errorHandlingShim) {
    server.errorHandlingShim = {
      handleError: async (errorPayload: unknown, contextPayload: unknown) => {
        const sanitizedError = formatErrorForErrorCenter(errorPayload) as string | Error | Record<string, unknown>;
        const sanitizedContext = formatErrorForErrorCenter(contextPayload) as Record<string, unknown> | undefined;
        await server.errorHandling.handleError({
          error: sanitizedError,
          source: 'pipeline',
          severity: 'medium',
          timestamp: Date.now(),
          context: sanitizedContext
        });
      },
      createContext: () => ({}),
      getStatistics: () => ({})
    };
  }
  return server.errorHandlingShim;
}

export function createDebugCenterShim(): DebugCenter {
  return {
    logDebug: () => {},
    logError: () => {},
    logModule: () => {},
    processDebugEvent: () => {},
    getLogs: () => []
  };
}

export function updateProviderProfiles(
  server: any,
  collection?: ProviderProfileCollection,
  rawConfig?: UnknownObject
): void {
  server.providerProfileIndex.clear();
  const source = collection ?? tryBuildProfiles(rawConfig);
  if (!source) {
    return;
  }
  for (const profile of source.profiles) {
    if (profile && typeof profile.id === 'string' && profile.id.trim()) {
      server.providerProfileIndex.set(profile.id.trim(), profile);
    }
  }
}

export function ensureProviderProfilesFromUserConfig(server: any): void {
  if (server.providerProfileIndex.size > 0) {
    return;
  }
  const fallback = tryBuildProfiles(server.userConfig);
  if (!fallback) {
    return;
  }
  for (const profile of fallback.profiles) {
    if (profile && typeof profile.id === 'string' && profile.id.trim()) {
      server.providerProfileIndex.set(profile.id.trim(), profile);
    }
  }
}

export function tryBuildProfiles(config: UnknownObject | undefined): ProviderProfileCollection | null {
  if (!config) {
    return null;
  }
  try {
    return buildProviderProfiles(config);
  } catch {
    return null;
  }
}

export function findProviderProfile(server: any, runtime: ProviderRuntimeProfile): ProviderProfile | undefined {
  const candidates = new Set<string>();
  const pushCandidate = (value?: string) => {
    if (typeof value === 'string' && value.trim()) {
      candidates.add(value.trim());
    }
  };
  pushCandidate(runtime.providerId);
  if (runtime.providerKey && runtime.providerKey.includes('.')) {
    pushCandidate(runtime.providerKey.split('.')[0]);
  }
  if (runtime.runtimeKey && runtime.runtimeKey.includes('.')) {
    pushCandidate(runtime.runtimeKey.split('.')[0]);
  }
  for (const candidate of candidates) {
    const profile = server.providerProfileIndex.get(candidate);
    if (profile) {
      return profile;
    }
  }
  return undefined;
}

export function applyProviderProfileOverrides(server: any, runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
  const profile = findProviderProfile(server, runtime);
  if (!profile) {
    return canonicalizeRuntimeProvider(runtime);
  }
  const patched: ProviderRuntimeProfile = { ...runtime };
  const originalFamily = patched.providerFamily || patched.providerType;
  patched.providerFamily = originalFamily;
  patched.providerType = profile.protocol as ProviderRuntimeProfile['providerType'];
  if (profile.moduleType && profile.moduleType.trim()) {
    patched.providerModule = profile.moduleType.trim();
  }
  if (!patched.baseUrl && profile.transport.baseUrl) {
    patched.baseUrl = profile.transport.baseUrl;
  }
  if (!patched.endpoint && profile.transport.endpoint) {
    patched.endpoint = profile.transport.endpoint;
  }
  if (!patched.headers && profile.transport.headers) {
    patched.headers = profile.transport.headers;
  }
  if (patched.timeoutMs === undefined && typeof profile.transport.timeoutMs === 'number') {
    patched.timeoutMs = profile.transport.timeoutMs;
  }
  if (patched.maxRetries === undefined && typeof profile.transport.maxRetries === 'number') {
    patched.maxRetries = profile.transport.maxRetries;
  }
  if (!patched.compatibilityProfile && profile.compatibilityProfile) {
    patched.compatibilityProfile = profile.compatibilityProfile;
  }
  if (!patched.defaultModel && profile.metadata?.defaultModel) {
    patched.defaultModel = profile.metadata.defaultModel;
  }
  if (!patched.deepseek && profile.metadata?.deepseek) {
    patched.deepseek = profile.metadata.deepseek;
  }

  return canonicalizeRuntimeProvider(patched);
}

export function canonicalizeRuntimeProvider(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
  const { providerType, providerFamily } = resolveProviderIdentity(runtime.providerType, runtime.providerFamily);
  return {
    ...runtime,
    providerType: providerType as ProviderRuntimeProfile['providerType'],
    providerFamily
  };
}

export function logStage(server: any, stage: string, requestId: string, details?: Record<string, unknown>): void {
  if (!server.stageLoggingEnabled) {
    return;
  }
  logPipelineStage(stage, requestId, details);
}

export function extractProviderModel(_server: any, payload?: Record<string, unknown>): string | undefined {
  if (!payload) {
    return undefined;
  }
  const source =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : payload;
  const raw = (source as Record<string, unknown>).model;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return undefined;
}

export function buildProviderLabel(_server: any, providerKey?: string, model?: string): string | undefined {
  const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : undefined;
  const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  if (!key && !modelId) {
    return undefined;
  }
  if (key && modelId) {
    const normalizedKey = key.toLowerCase();
    const normalizedModel = modelId.toLowerCase();
    if (normalizedKey === normalizedModel || normalizedKey.endsWith(`.${normalizedModel}`)) {
      return key;
    }
    return `${key}.${modelId}`;
  }
  return key || modelId;
}

export function normalizeAuthType(_server: any, input: unknown): 'apikey' | 'oauth' {
  const value = typeof input === 'string' ? input.toLowerCase() : '';
  if (value.includes('oauth')) {
    return 'oauth';
  }
  return 'apikey';
}

export async function resolveSecretValue(server: any, raw?: string): Promise<string> {
  if (!raw) {
    throw new Error('Secret reference is required but missing');
  }
  const trimmed = raw.trim();
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (envMatch) {
    const envValue = process.env[envMatch[1]];
    if (!envValue) {
      throw new Error(`Environment variable ${envMatch[1]} is not defined`);
    }
    return envValue;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    const envValue = process.env[trimmed];
    if (!envValue) {
      throw new Error(`Environment variable ${trimmed} is not defined`);
    }
    return envValue;
  }
  if (trimmed.startsWith('authfile-')) {
    return await server.authResolver.resolveKey(trimmed);
  }
  return trimmed;
}

export function isSafeSecretReference(_server: any, value: string): boolean {
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

export async function bootstrapVirtualRouter(_server: any, input: UnknownObject): Promise<VirtualRouterArtifacts> {
  const artifacts = (await bootstrapVirtualRouterConfig(input as Record<string, unknown>)) as unknown as VirtualRouterArtifacts;
  return artifacts;
}

export async function ensureHubPipelineCtor(server: any): Promise<HubPipelineCtor> {
  if (server.hubPipelineCtor) {
    return server.hubPipelineCtor;
  }
  const ctorFactory = await getHubPipelineCtor();
  server.hubPipelineCtor = ctorFactory as unknown as HubPipelineCtor;
  return server.hubPipelineCtor;
}

export async function ensureHubPipelineEngineShadow(server: any): Promise<HubPipeline> {
  if (server.hubPipelineEngineShadow) {
    return server.hubPipelineEngineShadow;
  }
  if (!server.hubPipelineConfigForShadow) {
    throw new Error('Hub pipeline shadow config is not initialized');
  }

  const baseConfig = server.hubPipelineConfigForShadow as unknown as Record<string, unknown>;
  const shadowConfig: Record<string, unknown> = { ...baseConfig };

  const routingStateStore = baseConfig.routingStateStore as
    | { loadSync?: (key: string) => unknown | null; saveAsync?: (key: string, state: unknown | null) => void }
    | undefined;
  if (routingStateStore && typeof routingStateStore.loadSync === 'function') {
    shadowConfig.routingStateStore = {
      loadSync: routingStateStore.loadSync.bind(routingStateStore),
      saveAsync: () => {}
    };
  }

  const healthStore = baseConfig.healthStore as
    | {
        loadInitialSnapshot?: () => unknown | null;
        persistSnapshot?: (snapshot: unknown) => void;
        recordProviderError?: (event: unknown) => void;
      }
    | undefined;
  if (healthStore && typeof healthStore.loadInitialSnapshot === 'function') {
    shadowConfig.healthStore = {
      loadInitialSnapshot: healthStore.loadInitialSnapshot.bind(healthStore)
    };
  }

  const quotaViewReadOnly = baseConfig.quotaViewReadOnly as ((providerKey: string) => unknown) | undefined;
  if (typeof quotaViewReadOnly === 'function') {
    shadowConfig.quotaView = quotaViewReadOnly;
  }

  const bridge = (await import('../../../modules/llmswitch/bridge.js')) as {
    getHubPipelineCtorForImpl?: (impl: 'engine') => Promise<unknown>;
  };
  const getCtor = bridge.getHubPipelineCtorForImpl;
  if (typeof getCtor !== 'function') {
    throw new Error('llmswitch bridge does not expose getHubPipelineCtorForImpl');
  }
  const ctorFactory = await getCtor('engine');
  const hubCtor = ctorFactory as unknown as HubPipelineCtor;
  if (!('virtualRouter' in shadowConfig)) {
    throw new Error('HubPipeline shadow config missing virtualRouter');
  }
  server.hubPipelineEngineShadow = new hubCtor(
    shadowConfig as unknown as { virtualRouter: unknown; [key: string]: unknown }
  ) as unknown as HubPipeline;
  return server.hubPipelineEngineShadow;
}

export function isPipelineReady(server: any): boolean {
  return Boolean(server.hubPipeline);
}

export async function waitForRuntimeReady(server: any): Promise<void> {
  if (server.runtimeReadyResolved) {
    return;
  }
  if (server.runtimeReadyError) {
    throw server.runtimeReadyError;
  }
  const raw = String(process.env.ROUTECODEX_STARTUP_HOLD_MS || process.env.RCC_STARTUP_HOLD_MS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      // ignore
    }
  });
  await Promise.race([server.runtimeReadyPromise, timeoutPromise]);
}

export function isQuotaRoutingEnabled(server: any): boolean {
  const flag = (server.config.server as { quotaRoutingEnabled?: unknown }).quotaRoutingEnabled;
  if (typeof flag === 'boolean') {
    return flag;
  }
  return true;
}

export function shouldStartManagerDaemon(_server: any): boolean {
  const mockFlag = String(process.env.ROUTECODEX_USE_MOCK || '').trim();
  if (mockFlag === '1' || mockFlag.toLowerCase() === 'true') {
    return false;
  }
  if (process.env.ROUTECODEX_MOCK_CONFIG_PATH || process.env.ROUTECODEX_MOCK_SAMPLES_DIR) {
    return false;
  }
  return true;
}

export async function initializeRouteErrorHub(server: any): Promise<void> {
  try {
    server.routeErrorHub = initializeRouteErrorHubImpl({ errorHandlingCenter: server.errorHandling });
    await server.routeErrorHub.initialize();
  } catch (error) {
    console.error('[RouteCodexHttpServer] Failed to initialize RouteErrorHub', error);
  }
}
