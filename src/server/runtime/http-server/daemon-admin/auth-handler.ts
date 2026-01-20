import type { Application, Request, Response } from 'express';
import { isLocalRequest } from '../daemon-admin-routes.js';
import { establishDaemonSession, isDaemonSessionAuthenticated, clearDaemonSession } from './auth-session.js';
import { readDaemonLoginRecord, verifyDaemonPassword, writeDaemonLoginRecord } from './auth-store.js';

function normalizePassword(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value;
}

export function registerDaemonAuthRoutes(app: Application): void {
  app.get('/daemon/auth/status', async (req: Request, res: Response) => {
    const loaded = await readDaemonLoginRecord();
    if (!loaded.ok) {
      res.status(500).json({ error: { message: loaded.error.message, code: 'login_file_error' } });
      return;
    }
    res.status(200).json({
      ok: true,
      hasPassword: Boolean(loaded.record),
      authenticated: isDaemonSessionAuthenticated(req)
    });
  });

  app.post('/daemon/auth/setup', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    const loaded = await readDaemonLoginRecord();
    if (!loaded.ok) {
      res.status(500).json({ error: { message: loaded.error.message, code: 'login_file_error' } });
      return;
    }
    if (loaded.record) {
      res.status(409).json({ error: { message: 'password already configured', code: 'already_configured' } });
      return;
    }
    const password = normalizePassword((req.body as any)?.password);
    if (password.length < 8 || password.length > 1024) {
      res.status(400).json({ error: { message: 'password must be 8..1024 characters', code: 'bad_request' } });
      return;
    }
    await writeDaemonLoginRecord(password);
    establishDaemonSession(res);
    res.status(200).json({ ok: true });
  });

  app.post('/daemon/auth/login', async (req: Request, res: Response) => {
    const loaded = await readDaemonLoginRecord();
    if (!loaded.ok) {
      res.status(500).json({ error: { message: loaded.error.message, code: 'login_file_error' } });
      return;
    }
    if (!loaded.record) {
      res.status(409).json({ error: { message: 'password not configured', code: 'not_configured' } });
      return;
    }
    const password = normalizePassword((req.body as any)?.password);
    const ok = await verifyDaemonPassword(password, loaded.record);
    if (!ok) {
      res.status(401).json({ error: { message: 'unauthorized', code: 'unauthorized' } });
      return;
    }
    establishDaemonSession(res);
    res.status(200).json({ ok: true });
  });

  app.post('/daemon/auth/change', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    if (!isDaemonSessionAuthenticated(req)) {
      res.status(401).json({ error: { message: 'unauthorized', code: 'unauthorized' } });
      return;
    }
    const loaded = await readDaemonLoginRecord();
    if (!loaded.ok) {
      res.status(500).json({ error: { message: loaded.error.message, code: 'login_file_error' } });
      return;
    }
    if (!loaded.record) {
      res.status(409).json({ error: { message: 'password not configured', code: 'not_configured' } });
      return;
    }
    const oldPassword = normalizePassword((req.body as any)?.oldPassword);
    const newPassword = normalizePassword((req.body as any)?.newPassword);
    if (newPassword.length < 8 || newPassword.length > 1024) {
      res.status(400).json({ error: { message: 'newPassword must be 8..1024 characters', code: 'bad_request' } });
      return;
    }
    const ok = await verifyDaemonPassword(oldPassword, loaded.record);
    if (!ok) {
      res.status(401).json({ error: { message: 'unauthorized', code: 'unauthorized' } });
      return;
    }
    await writeDaemonLoginRecord(newPassword);
    establishDaemonSession(res);
    res.status(200).json({ ok: true });
  });

  app.post('/daemon/auth/logout', async (_req: Request, res: Response) => {
    clearDaemonSession(res);
    res.status(200).json({ ok: true });
  });
}
