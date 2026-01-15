import type { Application, Request, Response } from 'express';
import express from 'express';
import type { ServerConfigV2 } from './types.js';

function isLocalhostRequest(req: Request): boolean {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function extractApiKey(req: Request): string {
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

export function registerApiKeyAuthMiddleware(app: Application, config: ServerConfigV2): void {
  const expectedKey = normalizeString(config?.server?.apikey);
  if (!expectedKey) {
    return;
  }

  app.use((req: Request, res: Response, next) => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const path = typeof req.path === 'string' ? req.path : '';
    if (path === '/health' || path === '/health/') {
      next();
      return;
    }

    const provided = extractApiKey(req);
    if (provided && provided === expectedKey) {
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
