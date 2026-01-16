import type { Application, Request, Response } from 'express';
import type { ManagerModule } from '../../../../manager/types.js';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

interface ModuleStatusView {
  id: string;
  status: 'running' | 'leader' | 'inactive';
  details?: Record<string, unknown>;
}

export function registerStatusRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/status', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;

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
    const version = String(process.env.ROUTECODEX_VERSION || 'dev');

    res.status(200).json({
      ok: true,
      serverId: options.getServerId(),
      version,
      uptimeSec,
      manager: {
        active: Boolean(manager),
        modules
      }
    });
  });

  // Admin-only module control helpers (stop/restart).
  // Intended for operational debugging (e.g. reload provider-quota snapshot after file deletion).
  app.post('/daemon/modules/:id/stop', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
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
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
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

  app.post('/daemon/modules/:id/reset', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
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
    const mod = daemon.getModule(id) as (ManagerModule & { reset?: (opts?: any) => Promise<unknown> }) | undefined;
    if (!mod) {
      res.status(404).json({ error: { message: 'module not found', code: 'not_found' } });
      return;
    }
    try {
      if (typeof mod.reset === 'function') {
        const result = await mod.reset({ persist: true });
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
