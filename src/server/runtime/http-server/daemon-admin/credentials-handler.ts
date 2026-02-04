import path from 'node:path';
import type { Application, Request, Response } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import { collectTokenSnapshot, readTokenFile, evaluateTokenState, resolveAuthDir } from '../../../../token-daemon/token-utils.js';
import { ensureValidOAuthToken } from '../../../../providers/auth/oauth-lifecycle.js';
import { withOAuthRepairEnv } from '../../../../providers/auth/oauth-repair-env.js';
import type { OAuthAuth, OAuthAuthType } from '../../../../providers/core/api/provider-config.js';
import { isCamoufoxAvailable } from '../../../../providers/core/config/camoufox-launcher.js';

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
  secretRef?: string;
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

  const apikeyMatches = await scanApiKeyAuthFiles();
  for (const match of apikeyMatches) {
    const hasApiKey = Boolean(match.hasApiKey);
    results.push({
      id: match.id,
      kind: 'apikey',
      provider: match.providerPrefix,
      alias: match.alias,
      tokenFile: match.filePath,
      displayName: match.alias && match.alias !== 'default' ? match.alias : match.id,
      expiresAt: null,
      expiresInSec: null,
      status: hasApiKey ? 'valid' : 'invalid',
      hasRefreshToken: false,
      hasAccessToken: false,
      hasApiKey,
      noRefresh: true,
      secretRef: `authfile-${path.basename(match.filePath)}`
    });
  }
  return results;
}

export function registerCredentialRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  const reject = (req: Request, res: Response) => rejectNonLocalOrUnauthorizedAdmin(req, res);

  app.get('/daemon/credentials', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    try {
      const items = await buildCredentialSummaries();
      res.status(200).json(items);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/daemon/credentials/:id', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
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
    if (reject(req, res)) {return;}
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
        status: summary.kind === 'apikey' ? summary.status : state.status,
        checkedAt: Date.now(),
        message: 'Verified locally (token file parsed and evaluated); no upstream call performed.'
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/daemon/credentials/:id/refresh', (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    // 为避免在 HTTP 请求路径中触发复杂的交互式 OAuth 流程，当前先返回明确的未实现标记。
    res.status(501).json({
      error: {
        message: 'manual refresh endpoint is not yet implemented; use CLI-based auth helpers instead',
        code: 'not_implemented'
      }
    });
  });

  app.post('/daemon/credentials/apikey', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
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
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/daemon/oauth/authorize', async (req: Request, res: Response) => {
    if (reject(req, res)) {return;}
    const body = req.body as Record<string, unknown>;
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const alias = typeof body?.alias === 'string' && body.alias.trim() ? body.alias.trim() : '';
    const openBrowser = body?.openBrowser !== false;
    const forceReauthorize = body?.forceReauthorize === true;
    if (!provider) {
      res.status(400).json({ error: { message: 'provider is required', code: 'bad_request' } });
      return;
    }
    if (!alias) {
      res.status(400).json({ error: { message: 'alias is required', code: 'bad_request' } });
      return;
    }
    if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
      res.status(400).json({ error: { message: `unsupported oauth provider: ${provider}`, code: 'bad_request' } });
      return;
    }
    try {
      const type: OAuthAuthType =
        provider === 'gemini-cli' ? 'gemini-cli-oauth' : (`${provider}-oauth` as OAuthAuthType);
      const auth: OAuthAuth = { type, tokenFile: alias };
      // Best effort: allow UI-configured browser selection without requiring restart.
      const browserHint = String(process.env.ROUTECODEX_OAUTH_BROWSER || '').trim();
      if (!browserHint) {
        const configPath = path.join(os.homedir(), '.routecodex', 'config.json');
        try {
          const raw = await fs.readFile(configPath, 'utf8');
          const parsed = raw.trim() ? JSON.parse(raw) : {};
          const oauthBrowser =
            typeof (parsed as { oauthBrowser?: unknown }).oauthBrowser === 'string'
              ? ((parsed as { oauthBrowser?: string }).oauthBrowser as string).trim()
              : '';
          if (oauthBrowser) {
            process.env.ROUTECODEX_OAUTH_BROWSER = oauthBrowser;
          }
        } catch {
          // ignore config read errors for browser hint
        }
      }

      // WebUI-triggered authorization should not attempt to auto-install Camoufox.
      // If Camoufox is missing, return an actionable error so user can install it explicitly.
      const prevAutoInstall = process.env.ROUTECODEX_CAMOUFOX_AUTO_INSTALL;
      process.env.ROUTECODEX_CAMOUFOX_AUTO_INSTALL = '0';
      try {
        if (openBrowser && !isCamoufoxAvailable()) {
          res.status(412).json({
            error: {
              code: 'camoufox_missing',
              message:
                'Camoufox is required for OAuth authorization. Install it first: python3 -m pip install --user -U camoufox'
            }
          });
          return;
        }
      } finally {
        if (prevAutoInstall === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_INSTALL;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_INSTALL = prevAutoInstall;
        }
      }

      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const restoreDevMode = () => {
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
      };
      // For explicit user-triggered authorization, prefer a headed Camoufox window so the user
      // can complete login/2FA if needed. Auto flow still runs; failures fall back to manual assist.
      if (openBrowser && !process.env.ROUTECODEX_CAMOUFOX_DEV_MODE) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      }
      try {
        await withOAuthRepairEnv(provider, async () => {
          await ensureValidOAuthToken(provider, auth, {
            openBrowser,
            forceReauthorize,
            forceReacquireIfRefreshFails: true
          });
        });
      } finally {
        restoreDevMode();
      }
      res.status(200).json({
        ok: true,
        provider,
        alias,
        tokenFile: typeof auth.tokenFile === 'string' ? auth.tokenFile : null
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });
}

type ApiKeyMatch = {
  filePath: string;
  providerPrefix: string;
  sequence: number;
  alias: string;
  id: string;
  hasApiKey: boolean;
};

const APIKEY_FILE_PATTERN = /^(.+)-apikey-(\d+)(?:-(.+))?\.key$/i;

async function scanApiKeyAuthFiles(): Promise<ApiKeyMatch[]> {
  try {
    const authDir = resolveAuthDir();
    const entries = await fs.readdir(authDir);
    const matches: ApiKeyMatch[] = [];
    for (const entry of entries) {
      const m = entry.match(APIKEY_FILE_PATTERN);
      if (!m) {
        continue;
      }
      const providerPrefix = m[1] || '';
      const sequence = parseInt(m[2], 10);
      const alias = (m[3] || 'default').trim() || 'default';
      if (!providerPrefix || !Number.isFinite(sequence) || sequence <= 0) {
        continue;
      }
      const filePath = path.join(authDir, entry);
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      const hasApiKey = Boolean(content && content.trim());
      matches.push({
        filePath,
        providerPrefix,
        sequence,
        alias,
        id: path.basename(entry, '.key'),
        hasApiKey
      });
    }
    matches.sort((a, b) => a.sequence - b.sequence);
    return matches;
  } catch {
    return [];
  }
}

async function allocateApiKeyFileName(provider: string, alias: string): Promise<string> {
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const safeAlias = alias.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const entries = await scanApiKeyAuthFiles();
  let maxSeq = 0;
  for (const entry of entries) {
    if (entry.providerPrefix.toLowerCase() !== safeProvider) {
      continue;
    }
    if (entry.sequence > maxSeq) {
      maxSeq = entry.sequence;
    }
  }
  const nextSeq = maxSeq + 1;
  return `${safeProvider}-apikey-${nextSeq}-${safeAlias}.key`;
}

const SUPPORTED_OAUTH_PROVIDERS = new Set(['iflow', 'qwen', 'gemini-cli', 'antigravity']);
