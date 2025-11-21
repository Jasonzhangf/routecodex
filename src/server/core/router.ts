import type { Express, Request, Response } from 'express';
import { handleChatCompletions } from '../handlers/chat-handler.js';
import { handleResponses } from '../handlers/responses-handler.js';
import { handleMessages } from '../handlers/messages-handler.js';
import { handleGetUserConfig, handleListProviderTemplates, handleValidateUserConfig, handleSaveUserConfig } from '../handlers/config-admin-handler.js';
import type { HandlerContext } from '../handlers/types.js';

export function attachRoutes(app: Express, makeCtx: () => HandlerContext): void {
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    await handleChatCompletions(req, res, makeCtx());
  });
  app.post('/v1/responses', async (req: Request, res: Response) => {
    await handleResponses(req, res, makeCtx());
  });
  app.post('/v1/messages', async (req: Request, res: Response) => {
    await handleMessages(req, res, makeCtx());
  });

  // Admin/config helpers
  app.get('/config', async (req: Request, res: Response) => { await handleGetUserConfig(req, res); });
  app.get('/config/templates', async (req: Request, res: Response) => { await handleListProviderTemplates(req, res); });
  app.post('/config/validate', async (req: Request, res: Response) => { await handleValidateUserConfig(req, res); });
  app.post('/config/save', async (req: Request, res: Response) => { await handleSaveUserConfig(req, res); });
}

