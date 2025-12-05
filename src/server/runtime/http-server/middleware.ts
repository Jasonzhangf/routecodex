import type { Application } from 'express';
import express from 'express';

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
