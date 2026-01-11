import type { Application, Request, Response } from 'express';
import type { ManagerModule } from '../../../../manager/types.js';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { isLocalRequest } from '../daemon-admin-routes.js';

interface ModuleStatusView {
  id: string;
  status: 'running' | 'leader' | 'inactive';
  details?: Record<string, unknown>;
}

export function registerStatusRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/status', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }

    const manager = options.getManagerDaemon() as
      | {
          getModule?: (id: string) => ManagerModule | undefined;
        }
      | null;
    const modules: ModuleStatusView[] = [];

    if (manager) {
      // 当前 ManagerDaemon 没有统一的 introspection 接口，这里仅基于已知 id 做轻量推断。
      const knownModuleIds = ['token', 'quota', 'health', 'routing'];
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
}
