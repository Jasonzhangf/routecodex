import path from 'node:path';
import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { isLocalRequest } from '../daemon-admin-routes.js';
import { collectTokenSnapshot, readTokenFile, evaluateTokenState } from '../../../../token-daemon/token-utils.js';

interface CredentialSummary {
  id: string;
  kind: 'oauth' | 'apikey';
  provider: string;
  alias: string;
  tokenFile: string;
  displayName: string;
  expiresAt: number | null;
  expiresInSec: number | null;
  status: string;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  hasApiKey: boolean;
  noRefresh: boolean;
}

async function buildCredentialSummaries(): Promise<CredentialSummary[]> {
  const snapshot = await collectTokenSnapshot();
  const results: CredentialSummary[] = [];
  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const id = path.basename(token.filePath).replace(/\.json$/i, '');
      const expiresAt = token.state.expiresAt;
      const expiresInSec =
        token.state.msUntilExpiry !== null && token.state.msUntilExpiry !== undefined
          ? Math.round(token.state.msUntilExpiry / 1000)
          : null;
      const kind: CredentialSummary['kind'] =
        token.state.hasAccessToken || token.state.hasRefreshToken ? 'oauth' : 'apikey';
      results.push({
        id,
        kind,
        provider: providerSnapshot.provider,
        alias: token.alias,
        tokenFile: token.filePath,
        displayName: token.displayName,
        expiresAt,
        expiresInSec,
        status: token.state.status,
        hasRefreshToken: token.state.hasRefreshToken,
        hasAccessToken: token.state.hasAccessToken,
        hasApiKey: token.state.hasApiKey,
        noRefresh: token.state.noRefresh === true
      });
    }
  }
  return results;
}

export function registerCredentialRoutes(app: Application, _options: DaemonAdminRouteOptions): void {
  app.get('/daemon/credentials', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    try {
      const items = await buildCredentialSummaries();
      res.status(200).json(items);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/daemon/credentials/:id', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required' } });
      return;
    }
    try {
      const items = await buildCredentialSummaries();
      const summary = items.find((c) => c.id === id);
      if (!summary) {
        res.status(404).json({ error: { message: 'credential not found', code: 'not_found' } });
        return;
      }
      // 详细视图：在 summary 基础上补充少量非敏感字段（例如 email/projectId），如果存在的话。
      const token = await readTokenFile(summary.tokenFile);
      const now = Date.now();
      const state = evaluateTokenState(token, now);
      const email =
        token && typeof (token as { email?: unknown }).email === 'string'
          ? (token as { email?: string }).email
          : undefined;
      const projectId =
        token && typeof (token as { project_id?: unknown }).project_id === 'string'
          ? (token as { project_id?: string }).project_id
          : undefined;
      res.status(200).json({
        ...summary,
        expiresAt: state.expiresAt,
        expiresInSec:
          state.msUntilExpiry !== null && state.msUntilExpiry !== undefined
            ? Math.round(state.msUntilExpiry / 1000)
            : null,
        status: state.status,
        email,
        projectId
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/daemon/credentials/:id/verify', async (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: { message: 'id is required' } });
      return;
    }
    try {
      const items = await buildCredentialSummaries();
      const summary = items.find((c) => c.id === id);
      if (!summary) {
        res.status(404).json({ error: { message: 'credential not found', code: 'not_found' } });
        return;
      }
      const token = await readTokenFile(summary.tokenFile);
      const state = evaluateTokenState(token, Date.now());
      res.status(200).json({
        ok: true,
        id: summary.id,
        status: state.status,
        checkedAt: Date.now(),
        message: 'Verified locally (token file parsed and evaluated); no upstream call performed.'
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/daemon/credentials/:id/refresh', (req: Request, res: Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
      return;
    }
    // 为避免在 HTTP 请求路径中触发复杂的交互式 OAuth 流程，当前先返回明确的未实现标记。
    res.status(501).json({
      error: {
        message: 'manual refresh endpoint is not yet implemented; use CLI-based auth helpers instead',
        code: 'not_implemented'
      }
    });
  });
}
