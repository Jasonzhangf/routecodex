import type { Application, Request, Response } from 'express';
import type { ManagerModule } from '../../../../manager/types.js';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import { buildInfo } from '../../../../build-info.js';

interface ModuleStatusView {
  id: string;
  status: 'running' | 'leader' | 'inactive';
  details?: Record<string, unknown>;
}

type RustQuotaHostSnapshotEntry = {
  providerKey?: unknown;
};

type RustQuotaHostMutator = {
  getStatus?(): Record<string, unknown> | null;
  resetProviderQuota?(providerKey: string): unknown;
};

function logDaemonStatusNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[daemon-status] ${operation} failed (non-blocking): ${reason}`);
}

function getRustQuotaHostMutator(options: DaemonAdminRouteOptions): RustQuotaHostMutator | null {
  const hubPipeline = typeof options.getHubPipeline === 'function' ? options.getHubPipeline() : null;
  if (!hubPipeline || typeof hubPipeline !== 'object') {
    return null;
  }
  const getVirtualRouter = (hubPipeline as { getVirtualRouter?: () => unknown | null }).getVirtualRouter;
  if (typeof getVirtualRouter !== 'function') {
    return null;
  }
  const virtualRouter = getVirtualRouter();
  if (!virtualRouter || typeof virtualRouter !== 'object') {
    return null;
  }
  return virtualRouter as RustQuotaHostMutator;
}

function readRustQuotaHostSnapshotProviderKeys(mutator: RustQuotaHostMutator | null): string[] {
  if (!mutator || typeof mutator.getStatus !== 'function') {
    return [];
  }
  try {
    const status = mutator.getStatus();
    const snapshot = Array.isArray(status?.quotaHostSnapshot) ? status?.quotaHostSnapshot : [];
    return snapshot
      .map((entry) => {
        const providerKey = typeof (entry as RustQuotaHostSnapshotEntry | null)?.providerKey === 'string'
          ? String((entry as RustQuotaHostSnapshotEntry).providerKey).trim()
          : '';
        return providerKey;
      })
      .filter((providerKey) => providerKey.length > 0);
  } catch (error: unknown) {
    logDaemonStatusNonBlockingError('readRustQuotaHostSnapshotProviderKeys', error);
    return [];
  }
}

function readRustVirtualRouterStatus(mutator: RustQuotaHostMutator | null): Record<string, unknown> | null {
  if (!mutator || typeof mutator.getStatus !== 'function') {
    return null;
  }
  try {
    const status = mutator.getStatus();
    return status && typeof status === 'object' ? status : null;
  } catch (error: unknown) {
    logDaemonStatusNonBlockingError('readRustVirtualRouterStatus', error);
    return null;
  }
}

export function registerStatusRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/status', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}

    const manager = options.getManagerDaemon() as
      | {
          getModule?: (id: string) => ManagerModule | undefined;
      }
      | null;
    const modules: ModuleStatusView[] = [];

    if (manager) {
      // 当前 ManagerDaemon 没有统一的 introspection 接口，这里仅基于已知 id 做轻量推断。
      const knownModuleIds = ['token', 'quota', 'provider-quota', 'health', 'routing'];
      for (const id of knownModuleIds) {
        const mod = typeof manager.getModule === 'function' ? manager.getModule(id) : undefined;
        if (!mod) {
          continue;
        }
        const base: ModuleStatusView = { id, status: 'running' };
        if (id === 'token') {
          // TokenManagerModule 暴露 isLeader 字段；但出于类型约束，我们只做 best-effort 读取。
          const anyMod = mod as unknown as { isLeader?: boolean };
          if (anyMod.isLeader === true) {
            base.status = 'leader';
          }
        }
        modules.push(base);
      }
    }

    const uptimeSec = process.uptime();
    const version = buildInfo?.version ? String(buildInfo.version) : String(process.env.ROUTECODEX_VERSION || 'dev');
    const rustMutator = getRustQuotaHostMutator(options);
    const virtualRouterStatus = readRustVirtualRouterStatus(rustMutator);

    res.status(200).json({
      ok: true,
      serverId: options.getServerId(),
      version,
      uptimeSec,
      manager: {
        active: Boolean(manager),
        modules
      },
      virtualRouter: virtualRouterStatus
    });
  });

  // Admin-only module control helpers (stop/restart).
  // Intended for operational debugging (e.g. reload provider-quota snapshot after file deletion).
  app.post('/daemon/modules/:id/stop', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    const daemon = options.getManagerDaemon() as { getModule?: (id: string) => ManagerModule | undefined } | null;
    if (!daemon || typeof daemon.getModule !== 'function') {
      res.status(503).json({ error: { message: 'manager daemon not available', code: 'not_ready' } });
      return;
    }
    const mod = daemon.getModule(id);
    if (!mod) {
      res.status(404).json({ error: { message: 'module not found', code: 'not_found' } });
      return;
    }
    try {
      await mod.stop();
      res.status(200).json({ ok: true, id, action: 'stop', stoppedAt: Date.now() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'module_stop_failed' } });
    }
  });

  app.post('/daemon/modules/:id/restart', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    const daemon = options.getManagerDaemon() as { getModule?: (id: string) => ManagerModule | undefined } | null;
    if (!daemon || typeof daemon.getModule !== 'function') {
      res.status(503).json({ error: { message: 'manager daemon not available', code: 'not_ready' } });
      return;
    }
    const mod = daemon.getModule(id);
    if (!mod) {
      res.status(404).json({ error: { message: 'module not found', code: 'not_found' } });
      return;
    }
    try {
      // restart = stop → init → start (best-effort; init/start implementations are expected to be idempotent)
      await mod.stop();
      await mod.init({ serverId: options.getServerId() });
      await mod.start();
      res.status(200).json({ ok: true, id, action: 'restart', restartedAt: Date.now() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'module_restart_failed' } });
    }
  });

  // Best-effort "refresh" semantics for modules that expose refreshNow()/reset().
  // This is primarily used by quota modules so the admin UI can force refresh without restart.
  app.post('/daemon/modules/:id/refresh', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    const daemon = options.getManagerDaemon() as { getModule?: (id: string) => ManagerModule | undefined } | null;
    if (!daemon || typeof daemon.getModule !== 'function') {
      res.status(503).json({ error: { message: 'manager daemon not available', code: 'not_ready' } });
      return;
    }
    const mod = daemon.getModule(id) as
      | (ManagerModule & {
          refreshNow?: (opts?: unknown) => Promise<unknown>;
          reset?: (opts?: unknown) => Promise<unknown>;
        })
      | undefined;
    if (!mod) {
      res.status(404).json({ error: { message: 'module not found', code: 'not_found' } });
      return;
    }
    try {
      if (typeof mod.refreshNow === 'function') {
        const result = await mod.refreshNow();
        res.status(200).json({ ok: true, id, action: 'refresh', refreshedAt: Date.now(), result });
        return;
      }
      if (typeof mod.reset === 'function') {
        const result = await mod.reset({ persist: true });
        res.status(200).json({ ok: true, id, action: 'refresh', refreshedAt: Date.now(), result, fallback: 'reset' });
        return;
      }
      await mod.stop();
      await mod.init({ serverId: options.getServerId() });
      await mod.start();
      res.status(200).json({ ok: true, id, action: 'refresh', refreshedAt: Date.now(), fallback: 'restart' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'module_refresh_failed' } });
    }
  });

  app.post('/daemon/modules/:id/reset', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    const daemon = options.getManagerDaemon() as { getModule?: (id: string) => ManagerModule | undefined } | null;
    if (!daemon || typeof daemon.getModule !== 'function') {
      res.status(503).json({ error: { message: 'manager daemon not available', code: 'not_ready' } });
      return;
    }
    const mod = daemon.getModule(id) as (ManagerModule & { reset?: (opts?: unknown) => Promise<unknown> }) | undefined;
    if (!mod) {
      // Back-compat for daemon-admin UI:
      // - UI uses module id "provider-quota", but current runtime registers quota manager under id "quota".
      // - When "provider-quota" module is absent, provide an explicit fallback that clears quotaView cooldown/blacklist
      //   by calling quota.resetProvider(...) on all known providerKeys.
      if (id === 'provider-quota') {
        const rustMutator = getRustQuotaHostMutator(options);
        const rustProviderKeys = readRustQuotaHostSnapshotProviderKeys(rustMutator);
        if (rustMutator && typeof rustMutator.resetProviderQuota === 'function' && rustProviderKeys.length > 0) {
          try {
            for (const providerKey of rustProviderKeys) {
              await Promise.resolve(rustMutator.resetProviderQuota(providerKey));
            }
            const quotaMod = daemon.getModule('quota') as
              | (ManagerModule & {
                  refreshNow?: () => Promise<unknown>;
                })
              | undefined;
            const quotaRefresh = await quotaMod?.refreshNow?.().catch((error: unknown) => {
              logDaemonStatusNonBlockingError('provider-quota.reset.refreshNow', error);
              return null;
            });
            res.status(200).json({
              ok: true,
              id,
              action: 'reset',
              resetAt: Date.now(),
              fallback: {
                kind: 'rust-quota.reset-all',
                providerCount: rustProviderKeys.length,
                ...(quotaRefresh ? { quotaRefresh } : {})
              }
            });
            return;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: { message, code: 'module_reset_failed' } });
            return;
          }
        }
        const quotaMod = daemon.getModule('quota') as
          | (ManagerModule & {
              getAdminSnapshot?: () => Record<string, unknown>;
              resetProvider?: (providerKey: string) => unknown;
              persistNow?: () => Promise<unknown>;
              refreshNow?: () => Promise<unknown>;
            })
          | undefined;
        const canResetAll =
          quotaMod &&
          typeof quotaMod.getAdminSnapshot === 'function' &&
          typeof quotaMod.resetProvider === 'function';
        if (canResetAll) {
          try {
            const snapshot = (quotaMod as any).getAdminSnapshot?.() ?? {};
            const providerKeys = Object.keys(snapshot);
            for (const providerKey of providerKeys) {
              await Promise.resolve((quotaMod as any).resetProvider(providerKey));
            }
            await (quotaMod as any).persistNow?.().catch((error: unknown) => {
              logDaemonStatusNonBlockingError('provider-quota.reset.persistNow', error);
            });
            const quotaRefresh = await (quotaMod as any).refreshNow?.().catch((error: unknown) => {
              logDaemonStatusNonBlockingError('provider-quota.reset.refreshNow', error);
              return null;
            });
            res.status(200).json({
              ok: true,
              id,
              action: 'reset',
              resetAt: Date.now(),
              fallback: {
                kind: 'quota.reset-all',
                providerCount: providerKeys.length,
                ...(quotaRefresh ? { quotaRefresh } : {})
              }
            });
            return;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: { message, code: 'module_reset_failed' } });
            return;
          }
        }
      }
      res.status(404).json({ error: { message: 'module not found', code: 'not_found' } });
      return;
    }
    try {
      if (typeof mod.reset === 'function') {
        const result = await mod.reset({ persist: true });
        // Special-case: resetting provider-quota should immediately trigger a quota refresh
        // so quota-aware providers are re-fetched instead of staying stale.
        if (id === 'provider-quota') {
          try {
            const quotaMod = daemon.getModule('quota') as unknown as { refreshNow?: () => Promise<unknown> } | undefined;
            if (quotaMod && typeof quotaMod.refreshNow === 'function') {
              const quotaRefresh = await quotaMod.refreshNow();
              res.status(200).json({
                ok: true,
                id,
                action: 'reset',
                resetAt: Date.now(),
                result,
                meta: { quotaRefresh }
              });
              return;
            }
          } catch {
            // ignore quota refresh failures on provider-quota reset
          }
        }
        res.status(200).json({ ok: true, id, action: 'reset', resetAt: Date.now(), result });
        return;
      }
      // Fallback: best-effort restart semantics (stop → init → start).
      await mod.stop();
      await mod.init({ serverId: options.getServerId() });
      await mod.start();
      res.status(200).json({ ok: true, id, action: 'reset', resetAt: Date.now(), fallback: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'module_reset_failed' } });
    }
  });
}
