import type { Express, Request, Response } from 'express';

export function attachCommonMiddleware(app: Express): void {
  try {
    const express = require('express');
    app.use(express.json({ limit: '10mb' }));
    app.use((req: Request, res: Response, next: Function) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { try { res.status(204).end(); } catch {} return; }
      next();
    });
  } catch {
    // minimal fallback: no JSON body parse
  }
}

export function attachHealthEndpoints(app: Express, getStatus: () => any, stopFn: () => Promise<void>): void {
  app.get('/health', (req: Request, res: Response) => {
    try { res.json({ status: 'healthy', uptime: process.uptime(), version: String(process.env.ROUTECODEX_VERSION || 'dev') }); }
    catch { try { res.status(200).end(); } catch {} }
  });
  app.get('/ready', (req: Request, res: Response) => {
    try { res.json({ status: 'ready', ...getStatus() }); }
    catch { try { res.status(200).end(); } catch {} }
  });
  app.post('/shutdown', async (req: Request, res: Response) => {
    try { res.json({ status: 'stopping' }); } catch {}
    try { await stopFn(); } catch {}
    try { process.exit(0); } catch {}
  });
}

