import type { Application, Request, Response } from 'express';
import { handleChatCompletions } from '../../handlers/chat-handler.js';
import { handleMessages } from '../../handlers/messages-handler.js';
import { handleResponses } from '../../handlers/responses-handler.js';
import type { HandlerContext } from '../../handlers/types.js';
import type { ServerConfigV2 } from './types.js';
import { reportRouteError } from '../../../error-handling/route-error-hub.js';
import { mapErrorToHttp } from '../../utils/http-error-mapper.js';

interface RouteOptions {
  app: Application;
  config: ServerConfigV2;
  buildHandlerContext: () => HandlerContext;
  getPipelineReady: () => boolean;
  handleError: (error: Error, context: string) => Promise<void>;
}

export function registerHttpRoutes(options: RouteOptions): void {
  const { app, config, buildHandlerContext, getPipelineReady, handleError } = options;

  console.log('[RouteCodexHttpServer] Setting up routes...');

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      server: 'routecodex',
      version: String(process.env.ROUTECODEX_VERSION || 'dev')
    });
  });

  app.get('/config', (_req: Request, res: Response) => {
    res.status(200).json({ httpserver: { host: config.server.host, port: config.server.port }, merged: false });
  });

  app.post('/shutdown', (req: Request, res: Response) => {
    try {
      const ip = req.socket?.remoteAddress || '';
      const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!allowed) {
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }
      res.status(200).json({ ok: true });
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          return;
        }
      }, 50);
    } catch {
      try {
        res.status(200).json({ ok: true });
      } catch {
        // ignore secondary response errors
      }
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          return;
        }
      }, 50);
    }
  });

  app.get('/debug/runtime', (_req: Request, res: Response) => {
    try {
      res.status(200).json({ pipelineReady: getPipelineReady() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/v1/chat/completions', async (req, res) => {
    await handleChatCompletions(req, res, buildHandlerContext());
  });
  app.post('/v1/messages', async (req, res) => {
    await handleMessages(req, res, buildHandlerContext());
  });
  app.post('/v1/responses', async (req, res) => {
    await handleResponses(req, res, buildHandlerContext());
  });
  app.post('/v1/responses/:id/submit_tool_outputs', async (req, res) => {
    await handleResponses(req, res, buildHandlerContext(), {
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      forceStream: true,
      responseIdFromPath: req.params?.id
    });
  });

  app.use('*', (_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: 'Not Found',
        type: 'not_found_error',
        code: 'not_found'
      }
    });
  });

  app.use(async (error: unknown, req: Request, res: Response) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const errorRecord = normalizedError as unknown as Record<string, unknown>;
    let mapped = mapErrorToHttp(normalizedError);
    try {
      const { http } = await reportRouteError({
        code: typeof errorRecord.code === 'string'
          ? String(errorRecord.code)
          : 'HTTP_MIDDLEWARE_ERROR',
        message: normalizedError.message,
        source: 'http-middleware.global',
        scope: 'http',
        severity: 'high',
        endpoint: req.path,
        requestId: typeof req.headers['x-request-id'] === 'string'
          ? req.headers['x-request-id']
          : undefined,
        details: {
          method: req.method,
          statusOverride: (error as { status?: number })?.status
        },
        originalError: normalizedError
      }, { includeHttpResult: true });
      if (http) {
        mapped = http;
      }
    } catch {
      /* ignore hub failures */
    }
    res.status(mapped.status).json(mapped.body);
  });

  console.log('[RouteCodexHttpServer] Routes setup completed');
}
