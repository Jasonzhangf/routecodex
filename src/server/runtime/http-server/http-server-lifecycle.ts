import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext } from '../../handlers/types.js';
import { registerHttpRoutes } from './routes.js';
import { canonicalizeServerId } from './server-id.js';
import { shutdownCamoufoxLaunchers } from '../../../providers/core/config/camoufox-launcher.js';
import {
  reportRouteError,
  type RouteErrorPayload
} from '../../../error-handling/route-error-hub.js';
import { formatValueForConsole } from '../../../utils/logger.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import { TokenManagerModule } from '../../../manager/modules/token/index.js';
import { asRecord } from './provider-utils.js';
import { loadRouteCodexConfig } from '../../../config/routecodex-config-loader.js';
import type { ProviderProfileCollection } from '../../../providers/profile/provider-profile.js';
import type { ServerStatusV2 } from './types.js';

export async function initializeHttpServer(server: any): Promise<void> {
  try {
    console.log('[RouteCodexHttpServer] Starting initialization...');

    await server.errorHandling.initialize();
    await server.initializeRouteErrorHub();

    if (server.shouldStartManagerDaemon() && !server.managerDaemon) {
      const daemon = new ManagerDaemon({
        serverId: canonicalizeServerId(server.config.server.host, server.config.server.port),
        quotaRoutingEnabled: server.isQuotaRoutingEnabled()
      });
      daemon.registerModule(new TokenManagerModule());
      daemon.registerModule(new RoutingStateManagerModule());
      daemon.registerModule(new HealthManagerModule());
      try {
        const mod = (await import('../../../manager/modules/quota/index.js')) as {
          QuotaManagerModule?: new () => import('../../../manager/modules/quota/index.js').QuotaManagerModule;
        };
        if (typeof mod.QuotaManagerModule === 'function') {
          daemon.registerModule(new mod.QuotaManagerModule());
        }
      } catch {
        // optional module
      }
      await daemon.start();
      server.managerDaemon = daemon;
    }

    registerHttpRoutes({
      app: server.app,
      config: server.config,
      buildHandlerContext: () => server.buildHandlerContext(),
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
      getVirtualRouterArtifacts: () => server.currentRouterArtifacts,
      getStatsSnapshot: () => ({
        session: server.stats.snapshot(Math.round(process.uptime() * 1000)),
        historical: server.stats.snapshotHistorical(),
        periods: server.stats.snapshotHistoricalPeriods()
      }),
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

  await new Promise<void>((resolve, reject) => {
    server.server = server.app.listen(server.config.server.port, server.config.server.host, () => {
      server._isRunning = true;

      const boundAddress = server.server?.address();
      const resolvedPort =
        boundAddress && typeof boundAddress === 'object' && typeof boundAddress.port === 'number'
          ? boundAddress.port
          : server.config.server.port;
      process.env.ROUTECODEX_SERVER_PORT = String(resolvedPort);

      console.log(`[RouteCodexHttpServer] Server started on ${server.config.server.host}:${resolvedPort}`);
      resolve();
    });

    if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
      try {
        (server.server as unknown as { unref?: () => void }).unref?.();
      } catch {
        // ignore
      }
    }

    server.server.on('connection', (socket: any) => {
      server.activeSockets.add(socket);
      socket.on('close', () => {
        server.activeSockets.delete(socket);
      });
    });

    server.server.on('error', async (error: Error) => {
      await server.handleError(error, 'server_start');
      reject(error);
    });
  });
}

export async function stopHttpServer(server: any): Promise<void> {
  server.stopClockDaemonInjectLoop();
  try {
    await shutdownCamoufoxLaunchers();
  } catch {
    // ignore launcher cleanup errors
  }
  if (!server.server) {
    return;
  }

  for (const socket of server.activeSockets) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
  server.activeSockets.clear();
  try {
    const srv = server.server as unknown as {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    srv.closeIdleConnections?.();
    srv.closeAllConnections?.();
  } catch {
    // ignore
  }

  await new Promise<void>((resolve) => {
    server.server?.close(async () => {
      server._isRunning = false;

      try {
        await server.disposeProviders();
      } catch {
        // ignore
      }
      try {
        if (server.managerDaemon) {
          await server.managerDaemon.stop();
          server.managerDaemon = null;
        }
      } catch {
        // ignore
      }
      try {
        server.server?.removeAllListeners();
      } catch {
        // ignore
      }
      server.server = undefined;
      await server.errorHandling.destroy();

      try {
        const uptimeMs = Math.round(process.uptime() * 1000);
        const summary = server.stats.logFinalSummary(uptimeMs);
        await server.stats.persistSnapshot(summary.session, { reason: 'server_shutdown' });
      } catch {
        // stats logging must never block shutdown
      }

      console.log('[RouteCodexHttpServer] Server stopped');
      resolve();
    });
  });
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
  if (!server.runtimeReadyResolved) {
    server.runtimeReadyResolved = true;
    server.runtimeReadyResolve?.();
  }
}

export function buildHttpHandlerContext(server: any): HandlerContext {
  return {
    executePipeline: server.executePipeline.bind(server),
    errorHandling: server.errorHandling
  };
}
