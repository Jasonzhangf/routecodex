import type { Application, Request, Response } from 'express';
import { handleChatCompletions } from '../../handlers/chat-handler.js';
import { handleMessages } from '../../handlers/messages-handler.js';
import { handleResponses } from '../../handlers/responses-handler.js';
import type { HandlerContext } from '../../handlers/types.js';
import type { ServerConfigV2 } from './types.js';

interface RouteOptions {
  app: Application;
  config: ServerConfigV2;
  buildHandlerContext: () => HandlerContext;
  getSuperPipelineReady: () => boolean;
  handleError: (error: Error, context: string) => Promise<void>;
}

export function registerHttpRoutes(options: RouteOptions): void {
  const { app, config, buildHandlerContext, getSuperPipelineReady, handleError } = options;

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
      const ip = (req.socket && (req.socket as any).remoteAddress) || '';
      const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!allowed) {
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }
      res.status(200).json({ ok: true });
      setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch {} }, 50);
    } catch {
      try { res.status(200).json({ ok: true }); } catch {}
      setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch {} }, 50);
    }
  });

  app.get('/debug/runtime', (_req: Request, res: Response) => {
    try {
      res.status(200).json({ superPipelineReady: getSuperPipelineReady() });
    } catch (e: any) {
      res.status(500).json({ error: { message: e?.message || String(e) } });
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

  app.use((error: any, _req: Request, res: Response) => {
    handleError(error as Error, 'request_handler').catch(() => undefined);
    const status = typeof error?.status === 'number' ? error.status : 500;
    res.status(status).json({
      error: {
        message: error?.message || 'Internal Server Error',
        type: error?.type || 'internal_error',
        code: error?.code || 'internal_error'
      }
    });
  });

  console.log('[RouteCodexHttpServer] Routes setup completed');
}
