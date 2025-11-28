import type { Application } from 'express';
import express from 'express';

export function registerDefaultMiddleware(app: Application): void {
  try {
    const json = (express as any).json || (() => undefined);
    app.use(json({ limit: '10mb' }));
    console.log('[RouteCodexHttpServer] Middleware: express.json enabled');
  } catch (error) {
    console.warn('[RouteCodexHttpServer] Failed to enable express.json; request bodies may be empty', error);
  }
}
