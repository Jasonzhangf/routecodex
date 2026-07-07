import type { Request } from 'express';
// feature_id: server.http_runtime_lifecycle
import type { PortConfig } from './port-config-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext } from '../../handlers/types.js';
import { registerHttpRoutes } from './routes.js';
import { canonicalizeServerId } from './server-id.js';
import {
  reportRouteError,
  type RouteErrorPayload
} from '../../../error-handling/route-error-hub.js';
import { formatValueForConsole } from '../../../utils/logger.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import { asRecord } from './provider-utils.js';
import { loadRouteCodexConfig } from '../../../config/routecodex-config-loader.js';
import type { ProviderProfileCollection } from '../../../providers/profile/provider-profile.js';
import type { ServerStatusV2 } from './types.js';
import { installPortLogConsoleRouter } from './port-log-context.js';
import { getTokenStatsSnapshot } from './executor/token-stats-store.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

function logLifecycleNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  const reason = formatValueForConsole(error);
  const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[RouteCodexHttpServer][lifecycle][non-blocking] stage=${stage} error=${reason}${detailSuffix}`);
}

export async function initializeHttpServer(server: any): Promise<void> {
  try {
    installPortLogConsoleRouter();
    console.log('[RouteCodexHttpServer] Starting initialization...');

    await server.errorHandling.initialize();
    await server.initializeRouteErrorHub();

    if (server.shouldStartManagerDaemon() && !server.managerDaemon) {
      const daemon = new ManagerDaemon({
        serverId: canonicalizeServerId(server.config.server.host, server.config.server.port),
        configPath: server.config?.configPath,
        getHubPipeline: () => server.hubPipeline,
      });
      daemon.registerModule(new RoutingStateManagerModule());
      daemon.registerModule(new HealthManagerModule());
      await daemon.start();
      server.managerDaemon = daemon;
    }

    registerHttpRoutes({
      app: server.app,
      config: server.config,
      buildHandlerContext: (req: Request) => server.buildHandlerContext(req),
      getPipelineReady: () => server.isPipelineReady(),
      waitForPipelineReady: async () => await server.waitForRuntimeReady(),
      handleError: (error: Error, context: string) => server.handleError(error, context),
      restartRuntimeFromDisk: async () => await server.restartRuntimeFromDisk(),
      getHealthSnapshot: () => {
        const healthModule = server.managerDaemon?.getModule('health') as HealthManagerModule | undefined;
        return healthModule?.getCurrentSnapshot() ?? null;
      },
      getRoutingState: (sessionId: string) => {
        const routingModule = server.managerDaemon?.getModule('routing') as RoutingStateManagerModule | undefined;
        const store = routingModule?.getRoutingStateStore();
        if (!store) {
          return null;
        }
        const key = sessionId && sessionId.trim() ? `session:${sessionId.trim()}` : '';
        return key ? store.loadSync(key) : null;
      },
      getManagerDaemon: () => server.managerDaemon,
      getHubPipeline: (routingPolicyGroup?: string) =>
        typeof server.resolveHubPipelineForRoutingPolicyGroup === 'function'
          ? server.resolveHubPipelineForRoutingPolicyGroup(routingPolicyGroup)
          : server.hubPipeline,
      getVirtualRouterArtifacts: () => server.currentRouterArtifacts,
      getUserConfig: () => server.userConfig,
      getStatsSnapshot: () => ({
        session: server.stats.snapshot(Math.round(process.uptime() * 1000)),
        historical: server.stats.snapshotHistorical(),
        periods: server.stats.snapshotHistoricalPeriods(),
        tokenStats: getTokenStatsSnapshot()
      }),
      getPortRegistry: () => server.getPortRegistry(),
      getPortConfigs: () => server.getPortConfigs(),
      applyPortConfig: (action: 'add' | 'update' | 'remove', port: number, config?: Record<string, unknown>) =>
        server.applyPortConfig(action, port, config),
      getAvailableProviders: () => server.getAvailableProviders(),
      getServerId: () => canonicalizeServerId(server.config.server.host, server.config.server.port)
    });

    server._isInitialized = true;
    console.log('[RouteCodexHttpServer] Initialization completed successfully');
  } catch (error) {
    await server.handleError(error as Error, 'initialization');
    throw error;
  }
}

export async function restartRuntimeFromDisk(
  server: any
): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> {
  const run = async (): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> => {
    const loaded = await loadRouteCodexConfig(server.config?.configPath);
    const userConfig = asRecord(loaded.userConfig) ?? {};
    const httpServerNode =
      asRecord((userConfig as Record<string, unknown>).httpserver) ??
      asRecord(asRecord((userConfig as Record<string, unknown>).modules)?.httpserver)?.config ??
      null;
    const nextApiKey =
      httpServerNode && typeof (httpServerNode as any).apikey === 'string'
        ? String((httpServerNode as any).apikey).trim()
        : '';
    const nextHost =
      httpServerNode && typeof (httpServerNode as any).host === 'string'
        ? String((httpServerNode as any).host).trim()
        : '';
    const nextPort =
      httpServerNode && typeof (httpServerNode as any).port === 'number'
        ? Number((httpServerNode as any).port)
        : NaN;

    const warnings: string[] = [];
    if (typeof nextApiKey === 'string' && nextApiKey !== String(server.config.server.apikey || '')) {
      server.config.server.apikey = nextApiKey || undefined;
    }
    if (nextHost && nextHost !== server.config.server.host) {
      warnings.push(
        `httpserver.host changed to "${nextHost}" but live server keeps "${server.config.server.host}" until process restart`
      );
    }
    if (Number.isFinite(nextPort) && nextPort > 0 && nextPort !== server.config.server.port) {
      warnings.push(
        `httpserver.port changed to ${nextPort} but live server keeps ${server.config.server.port} until process restart`
      );
    }

    server.config.configPath = loaded.configPath;

    await server.reloadRuntime(loaded.userConfig, { providerProfiles: loaded.providerProfiles });
    return { reloadedAt: Date.now(), configPath: loaded.configPath, ...(warnings.length ? { warnings } : {}) };
  };

  const slot = server.restartChain.then(run);
  server.restartChain = slot.then(() => undefined, () => undefined);
  return await slot;
}

export async function startHttpServer(server: any): Promise<void> {
  if (!server._isInitialized) {
    await server.initialize();
  }

  const portConfigs = server.getPortConfigs() as PortConfig[];
  try {
    for (const portConfig of portConfigs) {
      await server.startPortListener(portConfig);
    }
  } catch (error) {
    try {
      await server.getPortRegistry().stopAll();
    } catch (cleanupError) {
      logLifecycleNonBlockingError('start.cleanup_partial_listeners', cleanupError);
    }
    await server.handleError(error as Error, 'server_start');
    throw error;
  }
  server._isRunning = true;
  const listeners = server.getPortRegistry().snapshot();
  if (listeners.length === 1) {
    console.log(`[RouteCodexHttpServer] Server started on ${listeners[0].host}:${listeners[0].port}`);
  } else {
    console.log(
      `[RouteCodexHttpServer] Server started on ${listeners.map((item: { host: string; port: number }) => `${item.host}:${item.port}`).join(', ')}`
    );
  }
}

export async function stopHttpServer(server: any): Promise<void> {
  const logShutdownNonBlocking = (stage: string, error: unknown) => {
    const reason = formatValueForConsole(error);
    console.warn(`[RouteCodexHttpServer][shutdown][non-blocking] stage=${stage} error=${reason}`);
  };

  server.stopSessionDaemonInjectLoop();
  if (!server.server && server.getPortRegistry().size === 0) {
    return;
  }

  let socketDestroyFailures = 0;
  for (const socket of server.activeSockets) {
    try {
      socket.destroy();
    } catch {
      socketDestroyFailures += 1;
    }
  }
  if (socketDestroyFailures > 0) {
    console.warn(
      `[RouteCodexHttpServer][shutdown][non-blocking] stage=destroy_active_sockets failures=${socketDestroyFailures}`
    );
  }
  server.activeSockets.clear();
  try {
    const srv = server.server as unknown as {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    srv.closeIdleConnections?.();
    srv.closeAllConnections?.();
  } catch (error) {
    logShutdownNonBlocking('close_idle_or_all_connections', error);
  }

  try {
    await server.getPortRegistry().stopAll();
  } catch (error) {
    logShutdownNonBlocking('port_registry.stop_all', error);
  }
  server._isRunning = false;

  try {
    await server.disposeProviders();
  } catch (error) {
    logShutdownNonBlocking('dispose_providers', error);
  }
  try {
    server.disposeHubPipelines?.();
  } catch (error) {
    logShutdownNonBlocking('dispose_hub_pipelines', error);
  }
  try {
    if (server.managerDaemon) {
      await server.managerDaemon.stop();
      server.managerDaemon = null;
    }
  } catch (error) {
    logShutdownNonBlocking('stop_manager_daemon', error);
  }
  try {
    server.server?.removeAllListeners();
  } catch (error) {
    logShutdownNonBlocking('remove_server_listeners', error);
  }
  server.server = undefined;
  await server.errorHandling.destroy();

  try {
    const uptimeMs = Math.round(process.uptime() * 1000);
    const summary = server.stats.logFinalSummary(uptimeMs);
    await server.stats.persistSnapshot(summary.session, { reason: 'server_shutdown' });
  } catch (error) {
    logShutdownNonBlocking('persist_stats_snapshot', error);
  }

  console.log('[RouteCodexHttpServer] Server stopped');
}

export function getHttpServerStatus(server: any): ServerStatusV2 {
  return {
    initialized: server._isInitialized,
    running: server._isRunning,
    port: server.config.server.port,
    host: server.config.server.host,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: 'v2'
  };
}

export function getHttpServerConfig(server: any): { host: string; port: number } {
  return { host: server.config.server.host, port: server.config.server.port };
}

export function isHttpServerInitialized(server: any): boolean {
  return server._isInitialized;
}

export function isHttpServerRunning(server: any): boolean {
  return server._isRunning;
}

export async function handleHttpServerError(server: any, error: Error, context: string): Promise<void> {
  const payload: RouteErrorPayload = {
    code: `SERVER_${context.toUpperCase()}`,
    message: error.message || 'RouteCodex server error',
    source: `routecodex-server-v2.${context}`,
    scope: 'server',
    severity: 'medium',
    details: {
      name: error.name,
      stack: error.stack,
      version: 'v2'
    },
    originalError: error
  };
  try {
    await reportRouteError(payload);
  } catch (handlerError) {
    console.error(
      '[RouteCodexHttpServer] Failed to report error via RouteErrorHub:',
      formatValueForConsole(handlerError)
    );
    console.error('[RouteCodexHttpServer] Original error:', formatValueForConsole(error));
  }
}

export async function initializeWithUserConfig(
  server: any,
  userConfig: UnknownObject,
  context?: { providerProfiles?: ProviderProfileCollection }
): Promise<void> {
  try {
    server.updateProviderProfiles(context?.providerProfiles, userConfig);
    await server.setupRuntime(userConfig);
    await server.initializeRouteErrorHub();
    if (!server.runtimeReadyResolved) {
      server.runtimeReadyResolved = true;
      server.runtimeReadyResolve?.();
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    server.runtimeReadyError = normalized;
    if (!server.runtimeReadyResolved) {
      server.runtimeReadyReject?.(normalized);
    }
    throw error;
  }
}

export async function reloadHttpServerRuntime(
  server: any,
  userConfig: UnknownObject,
  context?: { providerProfiles?: ProviderProfileCollection }
): Promise<void> {
  server.updateProviderProfiles(context?.providerProfiles, userConfig);
  await server.setupRuntime(userConfig);
  await server.initializeRouteErrorHub();
  if (!server.runtimeReadyResolved) {
    server.runtimeReadyResolved = true;
    server.runtimeReadyResolve?.();
  }
}

export function buildHttpHandlerContext(server: any, req: Request): HandlerContext {
  const socketLocalPort =
    typeof req.socket?.localPort === 'number' && Number.isFinite(req.socket.localPort)
      ? req.socket.localPort
      : undefined;

  const parsePortFromHostHeader = (): number | undefined => {
    const hostHeader = (() => {
      const raw = req.headers?.host;
      if (Array.isArray(raw)) return raw[0];
      return typeof raw === 'string' ? raw : undefined;
    })();
    if (!hostHeader) return undefined;
    const trimmed = hostHeader.trim();
    if (!trimmed) return undefined;
    const ipv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
    if (ipv6Match?.[1]) {
      const p = Number.parseInt(ipv6Match[1], 10);
      return Number.isFinite(p) && p > 0 ? p : undefined;
    }
    const idx = trimmed.lastIndexOf(':');
    if (idx < 0) return undefined;
    const p = Number.parseInt(trimmed.slice(idx + 1), 10);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  };

  const hostHeaderPort = parsePortFromHostHeader();
  const hasPortConfig = (port: number | undefined): boolean => {
    if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) return false;
    try {
      const byLocal =
        typeof server?.getPortConfigForLocalPort === 'function'
          ? server.getPortConfigForLocalPort(port)
          : undefined;
      if (byLocal) return true;
      const ports = typeof server?.getPortConfigs === 'function' ? server.getPortConfigs() : [];
      return Array.isArray(ports) && ports.some((p: any) => Number(p?.port) === port);
    } catch {
      return false;
    }
  };

  // Priority: explicit Host header port (when valid configured listener) > socket local port.
  // This keeps per-port routing stable behind local proxies or shared-process multi-listener setups.
  const localPort = hasPortConfig(hostHeaderPort) ? hostHeaderPort : (socketLocalPort ?? hostHeaderPort);
  const matchedPortConfig =
    typeof server?.getPortConfigForLocalPort === 'function'
      ? server.getPortConfigForLocalPort(localPort)
      : undefined;
  const effectiveStopMessageEnabled = typeof matchedPortConfig?.stopMessage?.enabled === 'boolean'
    ? matchedPortConfig.stopMessage.enabled
    : true;
  const effectiveStopMessageExcludeDirect = matchedPortConfig?.stopMessage?.includeDirect === true
    ? false
    : true;
  const portContext = {
    ...(typeof socketLocalPort === 'number' ? { localPort: socketLocalPort } : {}),
    ...(typeof matchedPortConfig?.port === 'number' ? { matchedPort: matchedPortConfig.port } : {}),
    ...(typeof matchedPortConfig?.routingPolicyGroup === 'string' && matchedPortConfig.routingPolicyGroup.trim()
      ? { routingPolicyGroup: matchedPortConfig.routingPolicyGroup.trim() }
      : {}),
    ...(typeof matchedPortConfig?.port === 'number' ? { logNamespace: `server-${matchedPortConfig.port}` } : {}),
    stopMessageEnabled: effectiveStopMessageEnabled,
    stopMessageExcludeDirect: effectiveStopMessageExcludeDirect,
  };
  try {
    const requestPath =
      typeof req.path === 'string' && req.path.trim()
        ? req.path.trim()
        : (typeof req.originalUrl === 'string' ? req.originalUrl : '');
    const hostHeaderRaw = Array.isArray(req.headers?.host) ? req.headers.host[0] : req.headers?.host;
    const shouldLogPortResolve = process.env.ROUTECODEX_PORT_RESOLVE_LOGS === '1' || process.env.RCC_PORT_RESOLVE_LOGS === '1';
    if (shouldLogPortResolve && requestPath.includes('/v1/responses')) {
      console.log(
        `[port-resolve] host=${typeof hostHeaderRaw === 'string' ? hostHeaderRaw : '-'} `
        + `socket.localPort=${typeof socketLocalPort === 'number' ? socketLocalPort : '-'} `
        + `hostHeaderPort=${typeof hostHeaderPort === 'number' ? hostHeaderPort : '-'} `
        + `resolvedLocalPort=${typeof localPort === 'number' ? localPort : '-'} `
        + `matchedPort=${typeof matchedPortConfig?.port === 'number' ? matchedPortConfig.port : '-'} `
        + `matchedMode=${typeof matchedPortConfig?.mode === 'string' ? matchedPortConfig.mode : '-'} `
        + `matchedGroup=${typeof matchedPortConfig?.routingPolicyGroup === 'string' ? matchedPortConfig.routingPolicyGroup : '-'} `
        + `matchedBinding=${typeof matchedPortConfig?.providerBinding === 'string' ? matchedPortConfig.providerBinding : '-'} `
        + `url=${requestPath}`
      );
    }
  } catch {
    // non-blocking
  }
  return {
    executePipeline: (input) => server.executePortAwarePipeline(localPort, {
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        portContext,
        ...(typeof portContext.matchedPort === 'number' ? { matchedPort: portContext.matchedPort } : {}),
        ...(portContext.routingPolicyGroup ? { routingPolicyGroup: portContext.routingPolicyGroup } : {})
      }
    }),
    errorHandling: server.errorHandling,
    portContext
  };
}
