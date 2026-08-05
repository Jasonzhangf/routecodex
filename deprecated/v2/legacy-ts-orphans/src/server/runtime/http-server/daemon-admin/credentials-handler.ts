import path from 'node:path';
import type { Application, Request, Response } from 'express';
import fs from 'node:fs/promises';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import {
  allocateApiKeyFileName,
  buildCredentialSummaries,
  resolveAuthDir
} from './credentials-handler-utils.js';

export function registerCredentialRoutes(app: Application, _options: DaemonAdminRouteOptions): void {
  const reject = (req: Request, res: Response) => rejectNonLocalOrUnauthorizedAdmin(req, res);

  app.get('/daemon/credentials', async (req: Request, res: Response) => {
    if (reject(req, res)) { return; }
    try {
      res.status(200).json(await buildCredentialSummaries());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.get('/daemon/credentials/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) { return; }
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    try {
      const summary = (await buildCredentialSummaries()).find((credential) => credential.id === id);
      if (!summary) {
        res.status(404).json({ error: { message: 'credential not found', code: 'not_found' } });
        return;
      }
      res.status(200).json(summary);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.post('/daemon/credentials/:id/verify', async (req: Request, res: Response) => {
    if (reject(req, res)) { return; }
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required', code: 'bad_request' } });
      return;
    }
    try {
      const summary = (await buildCredentialSummaries()).find((credential) => credential.id === id);
      if (!summary) {
        res.status(404).json({ error: { message: 'credential not found', code: 'not_found' } });
        return;
      }
      res.status(200).json({
        ok: true,
        id: summary.id,
        status: summary.status,
        checkedAt: Date.now(),
        message: 'Verified locally (API key file exists and is non-empty); no upstream call performed.'
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.post('/daemon/credentials/apikey', async (req: Request, res: Response) => {
    if (reject(req, res)) { return; }
    const body = req.body as Record<string, unknown>;
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const alias = typeof body?.alias === 'string' && body.alias.trim() ? body.alias.trim() : 'default';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!provider) {
      res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
      return;
    }
    if (!apiKey) {
      res.status(400).json({ error: { message: 'apiKey is required', code: 'bad_request' } });
      return;
    }
    try {
      const fileName = await allocateApiKeyFileName(provider, alias);
      const authDir = resolveAuthDir();
      const filePath = path.join(authDir, fileName);
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(filePath, `${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
      res.status(200).json({
        ok: true,
        provider,
        alias,
        fileName,
        secretRef: `authfile-${fileName}`
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

}
