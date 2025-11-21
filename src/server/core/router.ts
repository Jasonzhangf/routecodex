import type { Express, Request, Response } from 'express';
import { handleChatCompletions } from '../handlers/chat-handler.js';
import { handleResponses } from '../handlers/responses-handler.js';
import { handleMessages } from '../handlers/messages-handler.js';
import { handleGetUserConfig, handleListProviderTemplates, handleValidateUserConfig, handleSaveUserConfig } from '../handlers/config-admin-handler.js';
import type { HandlerContext } from '../handlers/types.js';
import { HooksIntegration } from './hooks-integration.js';

export function attachRoutes(app: Express, makeCtx: () => HandlerContext, hooks?: HooksIntegration): void {
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const ctx = makeCtx();
    const endpoint = '/v1/chat/completions';
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await hooks?.executeStage('request_preprocessing', { hasBody: !!req.body, stream: !!(req as any)?.body?.stream }, { endpoint, requestId });
    try {
      await handleChatCompletions(req, res, ctx);
      await hooks?.executeStage('response_validation', { ok: true }, { endpoint, requestId });
    } catch (error) {
      await hooks?.executeStage('error_handling', { message: (error as any)?.message || String(error) }, { endpoint, requestId });
      throw error;
    }
  });
  app.post('/v1/responses', async (req: Request, res: Response) => {
    const ctx = makeCtx();
    const endpoint = '/v1/responses';
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await hooks?.executeStage('request_preprocessing', { hasBody: !!req.body, stream: !!(req as any)?.body?.stream }, { endpoint, requestId });
    try {
      await handleResponses(req, res, ctx);
      await hooks?.executeStage('response_validation', { ok: true }, { endpoint, requestId });
    } catch (error) {
      await hooks?.executeStage('error_handling', { message: (error as any)?.message || String(error) }, { endpoint, requestId });
      throw error;
    }
  });
  app.post('/v1/messages', async (req: Request, res: Response) => {
    const ctx = makeCtx();
    const endpoint = '/v1/messages';
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await hooks?.executeStage('request_preprocessing', { hasBody: !!req.body, stream: !!(req as any)?.body?.stream }, { endpoint, requestId });
    try {
      await handleMessages(req, res, ctx);
      await hooks?.executeStage('response_validation', { ok: true }, { endpoint, requestId });
    } catch (error) {
      await hooks?.executeStage('error_handling', { message: (error as any)?.message || String(error) }, { endpoint, requestId });
      throw error;
    }
  });

  // Admin/config helpers
  app.get('/config', async (req: Request, res: Response) => { await handleGetUserConfig(req, res); });
  app.get('/config/templates', async (req: Request, res: Response) => { await handleListProviderTemplates(req, res); });
  app.post('/config/validate', async (req: Request, res: Response) => { await handleValidateUserConfig(req, res); });
  app.post('/config/save', async (req: Request, res: Response) => { await handleSaveUserConfig(req, res); });
}
