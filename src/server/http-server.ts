import express, { type Application, type Request, type Response } from 'express';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { UnknownObject } from '../types/common-types.js';
import type { HandlerContext } from './handlers/types.js';
import { handleChatCompletions } from './handlers/chat-handler.js';
import { handleMessages } from './handlers/messages-handler.js';
import { handleResponses } from './handlers/responses-handler.js';

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

    // OpenAI Responses tool outputs continuation: /v1/responses/:id/submit_tool_outputs
    // Accepts { tool_outputs: [{ tool_call_id, output }], stream?: boolean }
    // Maps into a new Responses request with input: [{ type:'tool_result', tool_call_id, output }, ...]
    // Then re-enters the pipeline for the next round and streams SSE back.
    this.app.post('/v1/responses/:id/submit_tool_outputs', async (req: Request, res: Response) => {
      // Helper: emit error-shaped SSE for Responses (no normal synthesis here)
      const emitErrorSSE = (message: string, model: string) => {
        try { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); } catch {}
        const writeEvt = (ev: string, data: any) => { try { res.write(`event: ${ev}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
        const created = Math.floor(Date.now()/1000);
        const respId = `resp_${Date.now()}`;
        writeEvt('response.created', { type:'response.created', response:{ id: respId, object:'response', created_at: created, model, status:'in_progress', background: false, error: null, incomplete_details: null } });
        writeEvt('response.in_progress', { type:'response.in_progress', response:{ id: respId, object:'response', created_at: created, model, status:'in_progress' } });
        writeEvt('response.error', { type:'response.error', error: { message, code: 'UPSTREAM_OR_PIPELINE_ERROR', type: 'upstream_error' } });
        writeEvt('response.done', { type:'response.done' });
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
      };
      try {
        const responseId = String(req.params.id || '');
        const body = (req.body && typeof req.body === 'object') ? (req.body as any) : {};
        const toolOutputs = Array.isArray(body.tool_outputs) ? body.tool_outputs : [];
        const wantsSSE = body.stream === true || (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream'));
        let model: string = String(body.model || req.query.model || '').trim();
        if (!model) {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');
            const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
            if (fs.existsSync(base)) {
              const files = fs.readdirSync(base).filter((f: string) => f.endsWith('_response_mapped_json.json'));
              for (const f of files) {
                try {
                  const full = path.join(base, f);
                  const txt = fs.readFileSync(full, 'utf-8');
                  const j = JSON.parse(txt);
                  const data = (j && typeof j === 'object' && j.data && typeof j.data === 'object') ? (j.data as any) : undefined;
                  if (data && String(data.id || '') === responseId) { model = String(data.model || ''); break; }
                } catch { /* ignore one */ }
              }
            }
          } catch { /* ignore */ }
        }
        const input = toolOutputs.map((t: any) => ({ type: 'tool_result', tool_call_id: String((t && (t.tool_call_id || t.call_id || t.id)) || ''), output: (t && t.output != null) ? String(t.output) : '' }));
        const payload = { model: model || 'unknown', input, stream: true, previous_response_id: responseId } as any;
        if (!this.pipelineManager) {
          // No pipeline attached → emit error SSE (core should own streaming)
          return emitErrorSSE('Pipeline manager not attached', model || 'unknown');
        }
        // Try pipeline path; on provider 4xx/GLM errors, fallback to synthetic SSE
        try {
          const pipelineId = this.pickPipelineId();
          if (!pipelineId) { throw new Error('No pipeline available'); }
          const sharedReq = { data: payload, route: { providerId: 'unknown', modelId: String(payload.model||'unknown'), requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, timestamp: Date.now(), pipelineId }, metadata: { entryEndpoint: '/v1/responses', endpoint: '/v1/responses', stream: wantsSSE }, debug: { enabled: false, stages: {} } } as any;
          const response = await (this.pipelineManager as any).processRequest(sharedReq);
          const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
          if (wantsSSE) {
            if (out && typeof out === 'object' && (out as any).__sse_responses) {
              try { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); } catch {}
              (out as any).__sse_responses.pipe(res); return;
            }
            // No core SSE stream → do NOT synthesize normal SSE here; optional fallback by env
            if (String(process.env.ROUTECODEX_SERVER_SSE_FALLBACK || '0') === '1') {
              // legacy fallback: emit a minimal text SSE from tool outputs (discouraged)
              const text = input.map((i: any) => i.output).join('\n');
              const modelStr = String(payload.model||'unknown');
              return emitErrorSSE(text || 'Tool outputs submitted (server-fallback).', modelStr);
            }
            // default: error SSE
            return emitErrorSSE('Core did not produce Responses SSE stream', String(payload.model||'unknown'));
          } else {
            res.status(200).json(out); return;
          }
        } catch (err: any) {
          // Emit error SSE (no normal synthesis)
          const msg = String(err?.message || 'Upstream or pipeline error');
          return emitErrorSSE(msg, model || 'unknown');
        }
      } catch (error: any) {
        const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
        res.status(status).json({ error: { message: error?.message || String(error) } });
      }
    });
  }

  private buildHandlerContext(): HandlerContext {
    return {
      pipelineManager: this.pipelineManager,
      routePools: this.routePools,
      pickPipelineId: () => this.pickPipelineId(),
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
    // Declare SSE logger in outer scope so catch can access
    let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
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
          (payload as any).metadata = { ...meta, entryEndpoint, stream: wantsSSE };
        }
      } catch { /* ignore */ }
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
