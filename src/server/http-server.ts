import express, { type Application, type Request, type Response } from 'express';
import type { UnknownObject } from '../types/common-types.js';

/**
 * Minimal HttpServer adapter to satisfy V1 entrypoint.
 * - Reads host/port from merged-config.httpserver
 * - Exposes attach* methods used by index.ts (no-op aside from storing globals)
 * - Starts a basic Express app with health/config endpoints
 */
export class HttpServer {
  private app: Application;
  private server: any;
  private host: string = '0.0.0.0';
  private port: number = 5506;
  private mergedConfig: UnknownObject | null = null;
  private pipelineManager: any = null;
  private routePools: Record<string, string[]> = {};
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> = {} as any;

  constructor(_modulesConfigPath?: string) {
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));

    // Basic health endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', server: 'routecodex', version: String(process.env.ROUTECODEX_VERSION || 'dev') });
    });

    // Expose effective configuration for debugging
    this.app.get('/config', (_req: Request, res: Response) => {
      res.status(200).json({ httpserver: { host: this.host, port: this.port }, merged: !!this.mergedConfig });
    });

    // Local-only shutdown endpoint to support pre-start graceful replacement
    this.app.post('/shutdown', (req: Request, res: Response) => {
      try {
        const ip = (req.socket && (req.socket as any).remoteAddress) || '';
        const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!allowed) {
          res.status(403).json({ error: { message: 'forbidden' } });
          return;
        }
        res.status(200).json({ ok: true });
        // Give the response a moment to flush then exit
        setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ } }, 50);
      } catch {
        try { res.status(200).json({ ok: true }); } catch { /* ignore */ }
        setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ } }, 50);
      }
    });

    // Debug endpoint for pipeline manager state
    this.app.get('/debug/pipelines', (_req: Request, res: Response) => {
      try {
        const ids = Array.isArray(this.pipelineManager?.getPipelineIds?.()) ? this.pipelineManager.getPipelineIds() : [];
        res.status(200).json({ ids, routePools: this.routePools });
      } catch (e: any) {
        res.status(500).json({ error: { message: e?.message || String(e) } });
      }
    });
    // Core API endpoints (non-stream; SSE synthesis can be added later)
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      await this.handlePipelineRequest(req, res, '/v1/chat/completions');
    });

    this.app.post('/v1/messages', async (req: Request, res: Response) => {
      await this.handlePipelineRequest(req, res, '/v1/messages');
    });

    this.app.post('/v1/responses', async (req: Request, res: Response) => {
      await this.handlePipelineRequest(req, res, '/v1/responses');
    });
  }

  public async initializeWithMergedConfig(mergedConfig: any): Promise<void> {
    this.mergedConfig = (mergedConfig && typeof mergedConfig === 'object') ? (mergedConfig as UnknownObject) : null;
    try {
      const http = (this.mergedConfig as any)?.httpserver || (this.mergedConfig as any)?.modules?.httpserver?.config || {};
      const host = String(http.host || '0.0.0.0');
      const portRaw = http.port ?? (this.mergedConfig as any)?.server?.port ?? 5506;
      const port = typeof portRaw === 'number' ? portRaw : parseInt(String(portRaw), 10);
      this.host = host || '0.0.0.0';
      this.port = Number.isFinite(port) ? port : 5506;
    } catch { /* keep defaults */ }
  }

  public attachPipelineManager(manager: unknown): void {
    (globalThis as any).pipelineManager = manager;
    this.pipelineManager = manager;
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    (globalThis as any).routePools = routePools;
    this.routePools = routePools || {};
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    (globalThis as any).routeMeta = routeMeta;
    this.routeMeta = routeMeta || ({} as any);
  }

  public attachRoutingClassifierConfig(config: unknown): void {
    (globalThis as any).routingClassifierConfig = config;
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = this.app
        .listen(this.port, this.host, () => {
          const url = `http://${this.host}:${this.port}`;
          console.log(`🚀 RouteCodex HTTP Server started on ${url}`);
          console.log(`🌐 Server URL: ${url}`);
          console.log(`📊 Health check: ${url}/health`);
          console.log(`🔧 Configuration: ${url}/config`);
          resolve();
        })
        .on('error', (err: any) => {
          reject(err);
        });
    });
  }

  public async stop(): Promise<void> {
    if (this.server && this.server.close) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }

  // Internal helpers
  private pickPipelineId(): string | null {
    try {
      // Prefer 'default' route if present
      const defaultIds = this.routePools?.['default'];
      if (Array.isArray(defaultIds) && defaultIds.length > 0) {
        return String(defaultIds[0]);
      }
      // Otherwise, pick the first available id across all route pools
      for (const ids of Object.values(this.routePools || {})) {
        if (Array.isArray(ids) && ids.length > 0) {
          return String(ids[0]);
        }
      }
      // Fallback to manager listing
      const ids = Array.isArray(this.pipelineManager?.getPipelineIds?.()) ? this.pipelineManager.getPipelineIds() : [];
      if (ids.length > 0) { return String(ids[0]); }
    } catch { /* ignore */ }
    return null;
  }

  private async handlePipelineRequest(req: Request, res: Response, entryEndpoint: string): Promise<void> {
    try {
      if (!this.pipelineManager) {
        res.status(503).json({ error: { message: 'Pipeline manager not attached' } });
        return;
      }
      const pipelineId = this.pickPipelineId();
      if (!pipelineId) {
        res.status(500).json({ error: { message: 'No pipeline available' } });
        return;
      }
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const payload = req.body as UnknownObject;
      const wantsSSE =
        typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')
        || (payload && typeof payload === 'object' && ((payload as any).stream === true));
      // Also copy entryEndpoint into body.metadata for adapters that only see request.data
      try {
        if (payload && typeof payload === 'object') {
          const meta = ((payload as any).metadata && typeof (payload as any).metadata === 'object') ? (payload as any).metadata : {};
          (payload as any).metadata = { ...meta, entryEndpoint };
        }
      } catch { /* ignore */ }
      const sharedReq = {
        data: payload,
        route: { providerId: 'unknown', modelId: String((payload as any)?.model || 'unknown'), requestId, timestamp: Date.now(), pipelineId },
        metadata: { entryEndpoint, endpoint: entryEndpoint },
        debug: { enabled: false, stages: {} }
      } as any;
      // Also set root-level entry for adapters that check at the top level
      (sharedReq as any).entryEndpoint = entryEndpoint;

      try { console.log('[HTTP] sharedReq.meta', (sharedReq as any).metadata, 'root', (sharedReq as any).entryEndpoint); } catch { /* ignore */ }
      const response = await this.pipelineManager.processRequest(sharedReq);
      const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
      if (wantsSSE) {
        // Synthesize SSE from final JSON (non-stream) result
        await this.emitSSE(entryEndpoint, out, res);
      } else {
        res.status(200).json(out);
      }
    } catch (error: any) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      res.status(status).json({ error: { message: error?.message || String(error) } });
    }
  }

  private async emitSSE(entryEndpoint: string, finalJson: any, res: Response): Promise<void> {
    // Only implement OpenAI Chat synthesis here; Anthropic can be added when needed
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-RC-Synth', '1');
    const write = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const done = () => res.write('data: [DONE]\n\n');
    try {
      const now = Math.floor(Date.now() / 1000);
      if (entryEndpoint === '/v1/chat/completions') {
        const id = String(finalJson?.id || `chatcmpl_${Date.now()}`);
        const model = String(finalJson?.model || 'unknown');
        const role = String(finalJson?.choices?.[0]?.message?.role || 'assistant');
        const content = (finalJson?.choices?.[0]?.message?.content ?? '') as string;
        const tool_calls = finalJson?.choices?.[0]?.message?.tool_calls as any[] | undefined;
        // role chunk
        write({ id, object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: { role } }] });
        if (tool_calls && tool_calls.length) {
          // Emit tool_calls as a single delta chunk
          write({ id, object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: { tool_calls } }] });
          write({ id, object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          if (content && content.length) {
            write({ id, object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: { content } }] });
          }
          write({ id, object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        done();
        res.end();
        return;
      }
      // Fallback: emit whole object once
      write(finalJson ?? {});
      done();
      res.end();
    } catch (e) {
      // If SSE synthesis fails, fall back to JSON
      try { res.status(200).json(finalJson ?? {}); } catch { /* ignore */ }
    }
  }
}
