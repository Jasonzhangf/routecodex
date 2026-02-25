import type { Application, Request, Response } from 'express';
import express from 'express';
import type { ServerConfigV2 } from './types.js';
import {
  extractClockClientDaemonIdFromApiKey,
  extractClockClientTmuxSessionIdFromApiKey,
  matchesExpectedClientApiKey
} from '../../../utils/clock-client-token.js';
import {
  shouldTraceClockScopeByContext
} from '../../../utils/clock-scope-trace.js';

function isLocalhostRequest(req: Request): boolean {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function isLoopbackBindHost(hostRaw: unknown): boolean {
  const host = normalizeHost(hostRaw);
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function resolveEnvSecretReference(value: string): { ok: true; value: string } | { ok: false; missing: string } {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return { ok: true, value: '' };
  }
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (!envMatch) {
    return { ok: true, value: trimmed };
  }
  const envValue = normalizeString(process.env[envMatch[1]]);
  if (!envValue) {
    return { ok: false, missing: envMatch[1] };
  }
  return { ok: true, value: envValue };
}

export function extractApiKeyFromRequest(req: Request): string {
  const direct =
    normalizeString(req.header('x-routecodex-api-key'))
    || normalizeString(req.header('x-api-key'))
    || normalizeString(req.header('x-routecodex-apikey'))
    || normalizeString(req.header('api-key'))
    || normalizeString(req.header('apikey'));
  if (direct) {
    return direct;
  }
  const auth = normalizeString(req.header('authorization'));
  if (!auth) {
    return '';
  }
  const match = auth.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
  return match ? normalizeString(match[1]) : '';
}

function attachClientDaemonHint(req: Request, daemonId: string | undefined): void {
  if (!daemonId) {
    return;
  }
  try {
    const headers = req.headers as Record<string, unknown>;
    headers['x-routecodex-client-daemon-id'] = daemonId;
    headers['x-routecodex-clientd-id'] = daemonId;
    headers['x-routecodex-clock-daemon-id'] = daemonId;
    headers['x-routecodex-daemon-id'] = daemonId;
  } catch {
    // best-effort only
  }
}

function attachClientTmuxHint(req: Request, tmuxSessionId: string | undefined): void {
  if (!tmuxSessionId) {
    return;
  }
  try {
    const headers = req.headers as Record<string, unknown>;
    headers['x-routecodex-client-tmux-session-id'] = tmuxSessionId;
    headers['x-rcc-client-tmux-session-id'] = tmuxSessionId;
    headers['x-routecodex-tmux-session-id'] = tmuxSessionId;
    headers['x-rcc-tmux-session-id'] = tmuxSessionId;
    headers['x-tmux-session-id'] = tmuxSessionId;
  } catch {
    // best-effort only
  }
}

function shouldTraceClockScope(req: Request): boolean {
  const path = typeof req.path === 'string' ? req.path : '';
  const userAgent = normalizeString(req.header('user-agent')).toLowerCase();
  const originator = normalizeString(req.header('originator')).toLowerCase();
  const hasCodexTurnMetadata = normalizeString(req.header('x-codex-turn-metadata')).length > 0;
  return shouldTraceClockScopeByContext({
    endpointOrPath: path,
    userAgent,
    originator,
    hasTurnMetadata: hasCodexTurnMetadata
  });
}

function logClockScopeParse(args: {
  req: Request;
  requestId: string;
  hasApiKey: boolean;
  daemonId?: string;
  tmuxSessionId?: string;
}): void {
  if (!shouldTraceClockScope(args.req)) {
    return;
  }
  const path = typeof args.req.path === 'string' ? args.req.path : 'n/a';
  const userAgent = normalizeString(args.req.header('user-agent')) || 'n/a';
  const originator = normalizeString(args.req.header('originator')) || 'n/a';
  const hasTurnMetadata = normalizeString(args.req.header('x-codex-turn-metadata')).length > 0;
  console.log(
    `[clock-scope][parse] requestId=${args.requestId} path=${path} hasApiKey=${args.hasApiKey ? 'yes' : 'no'} ` +
    `daemon=${args.daemonId || 'none'} tmux=${args.tmuxSessionId || 'none'} originator=${originator} ua=${userAgent}` +
    ` hasTurnMeta=${hasTurnMetadata ? 'yes' : 'no'}`
  );
}

export function registerApiKeyAuthMiddleware(app: Application, config: ServerConfigV2): void {
  app.use((req: Request, res: Response, next) => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const provided = extractApiKeyFromRequest(req);
    let parsedDaemonId: string | undefined;
    let parsedTmuxSessionId: string | undefined;
    if (provided) {
      // Always decode daemon/tmux hints when a client token is present, even when apikey auth is disabled.
      // This keeps stopMessage/client-injection scope available in dev/no-auth deployments.
      parsedDaemonId = extractClockClientDaemonIdFromApiKey(provided);
      parsedTmuxSessionId = extractClockClientTmuxSessionIdFromApiKey(provided);
      attachClientDaemonHint(req, parsedDaemonId);
      attachClientTmuxHint(req, parsedTmuxSessionId);
    }
    const requestId = normalizeString(req.header('x-request-id')) || 'n/a';
    logClockScopeParse({
      req,
      requestId,
      hasApiKey: Boolean(provided),
      daemonId: parsedDaemonId,
      tmuxSessionId: parsedTmuxSessionId
    });

    const expectedResolved = resolveEnvSecretReference(normalizeString(config?.server?.apikey));
    if (!expectedResolved.ok) {
      res.status(500).json({
        error: {
          message: `Server misconfigured: environment variable ${expectedResolved.missing} is not defined`,
          type: 'config_error',
          code: 'missing_env'
        }
      });
      return;
    }
    const expectedKey = expectedResolved.value;
    if (!expectedKey) {
      next();
      return;
    }
    if (isLoopbackBindHost(config?.server?.host)) {
      next();
      return;
    }

    const path = typeof req.path === 'string' ? req.path : '';
    if (path === '/') {
      next();
      return;
    }
    // Daemon admin UI/API has its own password auth (not apikey).
    if (path === '/daemon/admin' || path === '/daemon/admin/' || path.startsWith('/daemon/')) {
      next();
      return;
    }
    // Manager state endpoints are also daemon-admin scoped (password auth).
    if (path.startsWith('/manager/state/')) {
      next();
      return;
    }
    // Daemon admin JSON APIs are intentionally not under /daemon/* (legacy); they are still admin-only and
    // must be protected by the daemon password session, not by apikey.
    if (
      path.startsWith('/providers/')
      || path.startsWith('/quota/')
      || path === '/quota/summary'
      || path === '/quota/providers'
      || path.startsWith('/config/providers')
      || path.startsWith('/config/routing')
      || path.startsWith('/config/settings')
    ) {
      next();
      return;
    }
    if (path === '/health' || path === '/health/') {
      next();
      return;
    }

    if (provided && matchesExpectedClientApiKey(provided, expectedKey)) {
      next();
      return;
    }

    if (path === '/token-auth/demo' && isLocalhostRequest(req)) {
      next();
      return;
    }

    res.status(401).json({
      error: {
        message: 'Unauthorized',
        type: 'auth_error',
        code: 'unauthorized'
      }
    });
  });
}

export function registerDefaultMiddleware(app: Application): void {
  try {
    if (typeof express.json === 'function') {
      app.use(express.json({ limit: '10mb' }));
      console.log('[RouteCodexHttpServer] Middleware: express.json enabled');
      return;
    }
    app.use((_req, _res, next) => { next(); });
    console.warn('[RouteCodexHttpServer] express.json not available; using no-op middleware');
  } catch (error) {
    console.warn('[RouteCodexHttpServer] Failed to enable express.json; request bodies may be empty', error);
  }
}
