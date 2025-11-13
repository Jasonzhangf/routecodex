import express, { type Application, type Request, type Response } from 'express';
import { writeServerSnapshot } from '../utils/snapshot-writer.js';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { UnknownObject } from '../types/common-types.js';
import type { HandlerContext } from './handlers/types.js';
import { handleChatCompletions } from './handlers/chat-handler.js';
import { handleMessages } from './handlers/messages-handler.js';
import { handleResponses } from './handlers/responses-handler.js';
import { handleSubmitToolOutputs } from './handlers/submit-tool-outputs-handler.js';

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
  private virtualRouter: any = null;
  private classifierConfig: unknown = null;
  // Minimal per-route round-robin index map used only as a last-resort fallback
  private rrIndex: Map<string, number> = new Map();

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
    // Core API endpoints — physically isolated handlers
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      await handleChatCompletions(req, res, this.buildHandlerContext());
    });

    this.app.post('/v1/messages', async (req: Request, res: Response) => {
      await handleMessages(req, res, this.buildHandlerContext());
    });

    this.app.post('/v1/responses', async (req: Request, res: Response) => {
      await handleResponses(req, res, this.buildHandlerContext());
    });

    this.app.post('/v1/responses/:id/submit_tool_outputs', async (req: Request, res: Response) => {
      await handleSubmitToolOutputs(req, res, this.buildHandlerContext());
    });
  }

  private buildHandlerContext(): HandlerContext {
    return {
      pipelineManager: this.pipelineManager,
      routePools: this.routePools,
      selectPipelineId: async (payload: any, entryEndpoint: string) => {
        // Prefer virtual router; on absence/misconfig, fall back to default route pool RR
        const pid = await this.pickPipelineIdViaVirtualRouter(payload as any, entryEndpoint);
        if (pid) return pid;
        const fb = this.pickPipelineId();
        if (!fb) { throw new Error('No pipeline available'); }
        return fb;
      },
    } as HandlerContext;
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
      // Snapshots toggle (default OFF). Allow config or env to enable.
      try {
        const snapsCfg = (this.mergedConfig as any)?.snapshots
          || (this.mergedConfig as any)?.modules?.httpserver?.config?.snapshots
          || (this.mergedConfig as any)?.debug?.snapshots
          || {};
        const env = String(process.env.ROUTECODEX_SNAPSHOTS || process.env.RCC_SNAPSHOTS || '').trim().toLowerCase();
        // Default behavior: snapshots ON unless explicitly disabled
        const disable = snapsCfg?.enabled === false || env === '0' || env === 'false' || env === 'no';
        const enable = snapsCfg?.enabled === true || env === '1' || env === 'true' || env === 'yes';
        if (disable) {
          try { (globalThis as any).rccSnapshotsEnabled = false; } catch { /* ignore */ }
        } else if (enable) {
          try { (globalThis as any).rccSnapshotsEnabled = true; } catch { /* ignore */ }
        } // else leave undefined → writer defaults to ON
      } catch { /* ignore */ }
    } catch { /* keep defaults */ }
  }

  public attachPipelineManager(manager: unknown): void {
    (globalThis as any).pipelineManager = manager;
    this.pipelineManager = manager;
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    (globalThis as any).routePools = routePools;
    this.routePools = routePools || {};
    this.ensureVirtualRouter();
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    (globalThis as any).routeMeta = routeMeta;
    this.routeMeta = routeMeta || ({} as any);
  }

  public attachRoutingClassifierConfig(config: unknown): void {
    (globalThis as any).routingClassifierConfig = config;
    this.classifierConfig = config;
    this.ensureVirtualRouter();
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

  private async pickPipelineIdViaVirtualRouter(payload: UnknownObject, entryEndpoint: string): Promise<string | null> {
    try {
      if (!this.virtualRouter) return null;
      // attach endpoint so classifier can see it
      try { (payload as any).endpoint = entryEndpoint; } catch { /* ignore */ }
      const routed = await this.virtualRouter.routeRequest(payload, 'default');
      const pid = (routed && (routed as any).routing && (routed as any).routing.pipelineId) ? String((routed as any).routing.pipelineId) : null;
      return pid;
    } catch { return null; }
  }

  private ensureVirtualRouter(): void {
    try {
      if (!this.classifierConfig || !this.routePools || Object.keys(this.routePools).length === 0) {
        return; // insufficient info
      }
      // Lazy create or re-init
      const needsInit = !this.virtualRouter;
      if (!this.virtualRouter) {
        try { const mod = require('../modules/virtual-router/virtual-router-module.js'); this.virtualRouter = new mod.VirtualRouterModule(); } catch { this.virtualRouter = null; }
      }
      if (this.virtualRouter && typeof this.virtualRouter.initialize === 'function') {
        this.virtualRouter.initialize({ classificationConfig: this.classifierConfig, routePools: this.routePools }).catch(()=>{});
      }
    } catch { /* ignore */ }
  }

  // Minimal fallback when Virtual Router is unavailable/misconfigured.
  // Selects a pipelineId by round-robin within the 'default' route pool if present,
  // otherwise the first available route pool. Intended to rarely execute.
  private pickPipelineId(): string | null {
    try {
      const pools = this.routePools || {};
      const poolNames = Object.keys(pools);
      if (poolNames.length === 0) return null;
      const routeName = pools['default'] ? 'default' : poolNames[0];
      const targets = pools[routeName] || [];
      if (!Array.isArray(targets) || targets.length === 0) return null;
      const idx = this.rrIndex.get(routeName) ?? 0;
      const pick = targets[idx % targets.length];
      this.rrIndex.set(routeName, (idx + 1) % Math.max(1, targets.length));
      return typeof pick === 'string' ? pick : null;
    } catch {
      return null;
    }
  }

  private async handlePipelineRequest(req: Request, res: Response, entryEndpoint: string): Promise<void> {
    // Declare SSE logger in outer scope so catch can access
    let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
    try {
      if (!this.pipelineManager) {
        res.status(503).json({ error: { message: 'Pipeline manager not attached' } });
        return;
      }
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const payload = req.body as UnknownObject;
      const wantsSSE =
        typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')
        || (payload && typeof payload === 'object' && ((payload as any).stream === true));
      // Server snapshot: http-request
      try { await writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint }); } catch { /* non-blocking */ }
      // Also copy entryEndpoint into body.metadata for adapters that only see request.data
      try {
        if (payload && typeof payload === 'object') {
          const meta = ((payload as any).metadata && typeof (payload as any).metadata === 'object') ? (payload as any).metadata : {};
          (payload as any).metadata = { ...meta, entryEndpoint, stream: wantsSSE };
        }
      } catch { /* ignore */ }
      // Resolve pipeline via Virtual Router (preferred), fallback to per-pool RR
      let pipelineId: string | null = await this.pickPipelineIdViaVirtualRouter(payload, entryEndpoint);
      if (!pipelineId) { pipelineId = this.pickPipelineId(); }
      if (!pipelineId) {
        res.status(500).json({ error: { message: 'No pipeline available' } });
        return;
      }
      // Server snapshot: routing-selected
      try { await writeServerSnapshot({ phase: 'routing-selected', requestId, data: { pipelineId }, entryEndpoint }); } catch { /* ignore */ }

      const sharedReq = {
        data: payload,
        route: { providerId: 'unknown', modelId: String((payload as any)?.model || 'unknown'), requestId, timestamp: Date.now(), pipelineId },
        metadata: { entryEndpoint, endpoint: entryEndpoint, stream: wantsSSE },
        debug: { enabled: false, stages: {} }
      } as any;
      // Also set root-level entry for adapters that check at the top level
      (sharedReq as any).entryEndpoint = entryEndpoint;

      try { console.log('[HTTP] sharedReq.meta', (sharedReq as any).metadata, 'root', (sharedReq as any).entryEndpoint); } catch { /* ignore */ }
      // If SSE requested for Responses, set headers early and emit pre-heartbeats while waiting
      let hbTimer: NodeJS.Timeout | null = null;
      // Simple SSE raw logger per request
      sseLogger = (() => {
        try {
          const dir = path.join(os.homedir(), '.routecodex', 'logs', 'sse');
          const ensure = async () => { try { await fsp.mkdir(dir, { recursive: true }); } catch {} };
          const file = path.join(dir, `${requestId}_server.sse.log`);
          return {
            async write(s: string) {
              try { await ensure(); await fsp.appendFile(file, `[${new Date().toISOString()}] ${s}`, 'utf-8'); } catch {}
            }
          };
        } catch { return { async write(_s: string) { /* ignore */ } }; }
      })();
      const startPreHeartbeat = () => {
        try {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          (res as any).flushHeaders?.();
        } catch { /* ignore */ }
        const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
        const writeBeat = () => { try { const s = `: pre-heartbeat ${Date.now()}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch { /* ignore */ } };
        writeBeat();
        hbTimer = setInterval(writeBeat, iv);
      };
      const stopPreHeartbeat = () => { try { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } } catch { /* ignore */ } };

      if (wantsSSE) {
        // 任何流式端点都提前发送心跳，确保客户端尽快收到首字节
        startPreHeartbeat();
      }

      const response = await this.pipelineManager.processRequest(sharedReq);
      const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
      // Prewrite snapshot (informational)
      try { await writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint }); } catch { /* ignore */ }
      if (wantsSSE) {
        if (entryEndpoint === '/v1/responses') {
          if (out && typeof out === 'object' && (out as any).__sse_responses) {
            // Core already prepared Responses SSE stream; stop pre-heartbeats and pipe.
            try { console.log('[HTTP][SSE] piping core stream for /v1/responses', { requestId }); } catch {}
            stopPreHeartbeat();
            try {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
              (res as any).flushHeaders?.();
            } catch { /* ignore */ }
            try {
              const { PassThrough } = await import('node:stream');
              const tee = new PassThrough();
              (out as any).__sse_responses.pipe(tee);
              tee.on('data', (chunk: Buffer) => { try { sseLogger.write(chunk.toString()).catch(()=>{}); } catch { /* ignore */ } });
              tee.pipe(res);
            } catch {
              (out as any).__sse_responses.pipe(res);
            }
            return;
          }
          // No core stream available: zero fallback — emit minimal SSE error + [DONE], do not fabricate frames
          stopPreHeartbeat();
          try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control','no-cache');
            res.setHeader('Connection','keep-alive');
          } catch {}
          try { console.log('[HTTP][SSE] NO CORE SSE for /v1/responses → error + [DONE]', { requestId }); } catch {}
          try {
            const s1 = `event: response.error\n`;
            const s2 = `data: ${JSON.stringify({ type:'response.error', error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE', type: 'pipeline_error' } })}\n\n`;
            res.write(s1); res.write(s2);
            sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{});
            const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
          } catch {}
          try { res.end(); } catch {}
          return;
        }
        // Anthropic Messages: 如果 core 产出了合成 SSE，直接透传
        if (entryEndpoint === '/v1/messages') {
          if (out && typeof out === 'object' && (out as any).__sse_responses) {
            try { console.log('[HTTP][SSE] piping core stream for /v1/messages', { requestId }); } catch {}
            stopPreHeartbeat();
            try {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
              (res as any).flushHeaders?.();
            } catch { /* ignore */ }
            try {
              const { PassThrough } = await import('node:stream');
              const tee = new PassThrough();
              (out as any).__sse_responses.pipe(tee);
              tee.on('data', (chunk: Buffer) => { try { sseLogger.write(chunk.toString()).catch(()=>{}); } catch { /* ignore */ } });
              tee.pipe(res);
            } catch {
              (out as any).__sse_responses.pipe(res);
            }
            return;
          }
          // No core stream available: zero fallback — emit minimal SSE error + [DONE]
          stopPreHeartbeat();
          try {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control','no-cache, no-transform');
            res.setHeader('Connection','keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
          } catch {}
          try { const s = `data: ${JSON.stringify({ error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE' } })}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch {}
          try { const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{}); } catch {}
          try { res.end(); } catch {}
          return;
        }
        // For Chat endpoint, if core produced SSE stream, pipe it directly; otherwise emit minimal error (zero fallback)
        if (entryEndpoint === '/v1/chat/completions') {
          if (out && typeof out === 'object' && (out as any).__sse_responses) {
            try { console.log('[HTTP][SSE] piping core stream for /v1/chat/completions', { requestId }); } catch {}
            stopPreHeartbeat();
            try {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
              (res as any).flushHeaders?.();
            } catch { /* ignore */ }
            try {
              const { PassThrough } = await import('node:stream');
              const tee = new PassThrough();
              (out as any).__sse_responses.pipe(tee);
              tee.on('data', (chunk: Buffer) => { try { sseLogger.write(chunk.toString()).catch(()=>{}); } catch { /* ignore */ } });
              tee.pipe(res);
            } catch {
              (out as any).__sse_responses.pipe(res);
            }
            return;
          }
          // No core stream available: zero fallback — emit minimal SSE error + [DONE]
          stopPreHeartbeat();
          try {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control','no-cache, no-transform');
            res.setHeader('Connection','keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
          } catch {}
          try { const s = `data: ${JSON.stringify({ error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE' } })}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch {}
          try { const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{}); } catch {}
          try { res.end(); } catch {}
          return;
        }
        // No other SSE synthesis paths allowed
        try { console.log('[HTTP][SSE] zero-fallback: no synthesis for', { entryEndpoint, requestId }); } catch {}
        stopPreHeartbeat();
        try {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control','no-cache, no-transform');
          res.setHeader('Connection','keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          const s = `data: ${JSON.stringify({ error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE' } })}\n\n`;
          res.write(s); sseLogger.write(s).catch(()=>{});
          const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
        } catch {}
        try { res.end(); } catch {}
        return;
      } else {
        stopPreHeartbeat();
        res.status(200).json(out);
      }
    } catch (error: any) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      // For Responses SSE, emit an SSE error frame instead of JSON so clients don't hang on heartbeats
      try {
        if (entryEndpoint === '/v1/responses' && (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream') || (req.body && req.body.stream === true))) {
          try { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); } catch {}
          const writeEvt = (ev: string, data: any) => { try { const s1 = `event: ${ev}\n`; const s2 = `data: ${JSON.stringify(data)}\n\n`; res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{}); } catch {} };
          const created = Math.floor(Date.now()/1000);
          const respId = `resp_${Date.now()}`;
          const model = String((req.body && req.body.model) || 'unknown');
          writeEvt('response.created', { type:'response.created', response:{ id: respId, object:'response', created_at: created, model, status:'in_progress', background: false, error: null, incomplete_details: null } });
          writeEvt('response.in_progress', { type:'response.in_progress', response:{ id: respId, object:'response', created_at: created, model, status:'in_progress' } });
          writeEvt('response.error', { type:'response.error', error: { message: String(error?.message || 'Upstream error'), code: String(error?.code || status || 'UPSTREAM_ERROR'), type: 'upstream_error' } });
          writeEvt('response.done', { type:'response.done' });
          try { const s = 'data: [DONE]\n\n'; res.write(s); sseLogger.write(s).catch(()=>{}); } catch {}
          try { res.end(); } catch {}
          return;
        }
        // For Chat/Messages SSE, if we already started streaming (pre-heartbeat) or client expects SSE,
        // emit a minimal SSE error payload then close with [DONE] to avoid hanging connections.
        const expectsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream'))
          || (req.body && req.body.stream === true);
        if (expectsSSE) {
          try {
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control','no-cache');
              res.setHeader('Connection','keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
              (res as any).flushHeaders?.();
            }
          } catch { /* ignore */ }
          try {
            const payload = { error: { message: String(error?.message || 'Upstream error'), code: String((error as any)?.code || status || 'UPSTREAM_ERROR') } };
            const s1 = `data: ${JSON.stringify(payload)}\n\n`;
            res.write(s1); sseLogger.write(s1).catch(()=>{});
          } catch { /* ignore */ }
          try { const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{}); } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
          return;
        }
      } catch { /* fall back to JSON */ }
      if (!res.headersSent) {
        res.status(status).json({ error: { message: error?.message || String(error) } });
      }
    }
  }

  private async emitSSE(entryEndpoint: string, finalJson: any, res: Response, sseLogger?: { write: (line: string) => Promise<void> }): Promise<void> {
    // Only implement OpenAI Chat/Responses synthesis here; Anthropic can be added when needed
    // If pre-heartbeats already sent headers/bytes, avoid re-setting headers to prevent ERR_HTTP_HEADERS_SENT
    try {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        (res as any).flushHeaders?.();
        res.setHeader('X-RC-Synth', '1');
      }
    } catch { /* ignore */ }
    const write = (obj: any) => { const s = `data: ${JSON.stringify(obj)}\n\n`; res.write(s); try { sseLogger?.write(s).catch(()=>{}); } catch {} };
    const writeEvt = (event: string, data: any) => {
      try { const s1 = `event: ${event}\n`; res.write(s1); try { sseLogger?.write(s1).catch(()=>{}); } catch {}
      } catch { /* ignore */ }
      try { const s2 = `data: ${JSON.stringify(data)}\n\n`; res.write(s2); try { sseLogger?.write(s2).catch(()=>{}); } catch {}
      } catch { /* ignore */ }
    };
    const done = () => { const s = 'data: [DONE]\n\n'; try { res.write(s); } catch { /* ignore */ } try { sseLogger?.write(s).catch(()=>{}); } catch {} };
    let completed = false;
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
      if (entryEndpoint === '/v1/responses') {
        const created = Math.floor(Date.now() / 1000);
        const model = String(finalJson?.model || 'unknown');
        const respId = String(finalJson?.id || `resp_${Date.now()}`);
        try { writeEvt('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: created, model, status: 'in_progress' } }); } catch {}
        try { writeEvt('response.in_progress', { type: 'response.in_progress', response: { id: respId, object: 'response', created_at: created, model, status: 'in_progress' } }); } catch {}
        // Emit output_text if present
        try {
          let text = '';
          if (typeof (finalJson as any)?.output_text === 'string') {
            text = String((finalJson as any).output_text);
          } else if (Array.isArray((finalJson as any)?.output)) {
            const outArr = ((finalJson as any).output as any[]).filter(Boolean);
            for (const item of outArr) {
              if (String(item?.type || '').toLowerCase() === 'message' && item?.message && Array.isArray(item.message.content)) {
                const parts = item.message.content as any[];
                const joined = parts.map(p => typeof p?.text === 'string' ? p.text : (typeof p === 'string' ? p : '')).filter(Boolean).join('');
                if (joined && joined.length) { text = joined; break; }
              }
            }
          }
          if (text && text.length) {
            writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text, logprobs: [] });
            writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, logprobs: [] });
          }
        } catch { /* ignore */ }
        // Emit required_action if present or derivable
        try {
          const ra = (finalJson as any)?.required_action;
          const directCalls = (ra?.type === 'submit_tool_outputs') ? (ra?.submit_tool_outputs?.tool_calls || []) : [];
          let emittedRA = false;
          if (Array.isArray(directCalls) && directCalls.length > 0) {
            writeEvt('response.required_action', { type: 'response.required_action', response: { id: respId, object: 'response', created, model }, required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: directCalls } } });
            emittedRA = true;
          }
          if (!emittedRA && Array.isArray((finalJson as any)?.output)) {
            const items = ((finalJson as any).output as any[]).filter(x => x && typeof x === 'object' && String(x.type||'').toLowerCase() === 'function_call');
            if (items.length > 0) {
              const tool_calls = items.map((it: any) => ({ id: String(it.id || it.call_id || `call_${Math.random().toString(36).slice(2,10)}`), type: 'function', function: { name: String(it.name || (it.function?.name) || ''), arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) } }));
              writeEvt('response.required_action', { type: 'response.required_action', response: { id: respId, object: 'response', created, model }, required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls } } });
            }
          }
        } catch { /* ignore */ }
        // Always emit completed with usage normalization
        try {
          const base: any = finalJson ?? { id: respId, object: 'response', created_at: created, model, status: 'completed' };
          const u: any = (base as any).usage || {};
          const iu = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
          const ou = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
          const tt = typeof u.total_tokens === 'number' ? u.total_tokens : (iu + ou);
          base.usage = { input_tokens: iu, output_tokens: ou, total_tokens: tt };
          writeEvt('response.completed', { type: 'response.completed', response: base });
          completed = true;
        } catch {}
        try { writeEvt('response.done', { type: 'response.done' }); } catch {}
        done();
        res.end();
        return;
      }
      // Default: emit whole object once
      write(finalJson ?? {});
      done();
      try { res.end(); } catch { /* ignore */ }
    } catch (e) {
      // Do not fall back to JSON after SSE has started; emit an SSE error frame then [DONE]
      try {
        const errMsg = (e && (e as any).message) ? String((e as any).message) : 'SSE synthesis error';
        if (entryEndpoint === '/v1/chat/completions') {
          const payload = { error: { message: errMsg, type: 'server_error' } };
          const s = `data: ${JSON.stringify(payload)}\n\n`;
          try { res.write(s); } catch { /* ignore */ }
          try { sseLogger?.write(s).catch(()=>{}); } catch { /* ignore */ }
          done();
          try { res.end(); } catch { /* ignore */ }
        } else if (entryEndpoint === '/v1/responses') {
          // Keep Responses error shape consistent if emitSSE was called for it (normally core handles Responses SSE)
          const err = { type: 'response.error', error: { message: errMsg, code: 'SSE_SYNTH_ERROR', type: 'server_error' } };
          const s1 = `event: response.error\n`;
          const s2 = `data: ${JSON.stringify(err)}\n\n`;
          try { res.write(s1); res.write(s2); } catch { /* ignore */ }
          try { sseLogger?.write(s1).catch(()=>{}); sseLogger?.write(s2).catch(()=>{}); } catch { /* ignore */ }
          const s3 = 'data: [DONE]\n\n';
          try { res.write(s3); } catch { /* ignore */ }
          try { sseLogger?.write(s3).catch(()=>{}); } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
        } else {
          const payload = { error: { message: errMsg, type: 'server_error' } };
          const s = `data: ${JSON.stringify(payload)}\n\n`;
          try { res.write(s); } catch { /* ignore */ }
          try { sseLogger?.write(s).catch(()=>{}); } catch { /* ignore */ }
          done();
          try { res.end(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    } finally {
      // Guard for responses: ensure completed/done
      try {
        if (entryEndpoint === '/v1/responses' && !completed) {
          const created = Math.floor(Date.now() / 1000);
          const model = String(finalJson?.model || 'unknown');
          const respId = String(finalJson?.id || `resp_${Date.now()}`);
          const u: any = (finalJson as any)?.usage || {};
          const iu = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
          const ou = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
          const tt = typeof u.total_tokens === 'number' ? u.total_tokens : (iu + ou);
          const base: any = { id: respId, object: 'response', created_at: created, model, status: 'completed', usage: { input_tokens: iu, output_tokens: ou, total_tokens: tt } };
          try { write({ type: 'response.completed', response: base, meta: { guard: true } }); } catch {}
          try { write({ type: 'response.done' }); } catch {}
          try { done(); } catch {}
          try { res.end(); } catch {}
        }
      } catch { /* ignore */ }
    }
  }

  // No server-side transformer; SSE is produced by llmswitch-core.
}
