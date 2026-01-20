import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

export function registerRestartRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.post('/daemon/restart', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}

    const restart = options.restartRuntimeFromDisk;
    if (typeof restart !== 'function') {
      res.status(501).json({ error: { message: 'restart endpoint not available', code: 'not_implemented' } });
      return;
    }

    try {
      const result = await restart();
      res.status(200).json({ ok: true, ...result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'restart_failed' } });
    }
  });
}
