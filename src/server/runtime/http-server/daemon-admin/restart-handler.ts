import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

export function registerRestartRoutes(app: Application, options: DaemonAdminRouteOptions): void {

  app.post('/daemon/restart-process', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    if (process.platform === 'win32') {
      res.status(501).json({ error: { message: 'process restart via signal is unavailable on win32', code: 'not_implemented' } });
      return;
    }

    res.status(202).json({ ok: true, accepted: true, action: 'restart-process' });
    const trigger = () => {
      try {
        process.kill(process.pid, 'SIGUSR2');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[daemon-admin] failed to trigger process restart', message);
      }
    };
    if (res.writableEnded) {
      setTimeout(trigger, 0);
      return;
    }
    res.once('finish', () => {
      setTimeout(trigger, 0);
    });
  });

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
