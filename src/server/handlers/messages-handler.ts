import type { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';

// Anthropic Messages endpoint: /v1/messages (Anthropic SSE with named events)
export async function handleMessages(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
  const entryEndpoint = '/v1/messages';
  try {
    if (!ctx.pipelineManager) { res.status(503).json({ error: { message: 'Pipeline manager not attached' } }); return; }
    const payload = (req.body || {}) as any;
    const pipelineId = await ctx.selectPipelineId(payload, entryEndpoint);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Snapshot: http-request
    try { await writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint }); } catch { /* non-blocking */ }
    const wantsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || payload.stream === true;
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: wantsSSE };
    } catch { /* ignore */ }
    const sharedReq: any = {
      data: payload,
      route: { providerId: 'unknown', modelId: String(payload?.model || 'unknown'), requestId, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: wantsSSE },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };
    // SSE logger
    sseLogger = (() => {
      try {
        const dir = path.join(os.homedir(), '.routecodex', 'logs', 'sse');
        const ensure = async () => { try { await fsp.mkdir(dir, { recursive: true }); } catch {} };
        const file = path.join(dir, `${requestId}_server.sse.log`);
        return { async write(s: string) { try { await ensure(); await fsp.appendFile(file, `[${new Date().toISOString()}] ${s}`, 'utf-8'); } catch {} } };
      } catch { return { async write(_s: string) { /* ignore */ } }; }
    })();
    // Pre heartbeat
    let hbTimer: NodeJS.Timeout | null = null;
    const startPreHeartbeat = () => {
      try {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        (res as any).flushHeaders?.();
      } catch { /* ignore */ }
      const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
      const writeBeat = () => { try { const s = `: pre-heartbeat ${Date.now()}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch {} };
      writeBeat(); hbTimer = setInterval(writeBeat, iv);
    };
    const stopPreHeartbeat = () => { try { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } } catch {} };
    if (wantsSSE) startPreHeartbeat();

    // Snapshot: routing-selected
    try { await writeServerSnapshot({ phase: 'routing-selected', requestId, data: { pipelineId }, entryEndpoint }); } catch { /* ignore */ }
    const response = await ctx.pipelineManager.processRequest(sharedReq);
    const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
    // 优先：如果核心返回了 __sse_responses，无条件按 SSE 管道输出（零回退，忽略 Accept/stream）
    if (out && typeof out === 'object' && (out as any).__sse_responses) {
      try { console.log('[HTTP][SSE] piping core stream for /v1/messages', { requestId }); } catch {}
      stopPreHeartbeat();
      try {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control','no-cache, no-transform');
        res.setHeader('Connection','keep-alive');
        res.setHeader('X-Accel-Buffering','no');
      } catch {}
      try {
        const { PassThrough } = await import('node:stream');
        const tee = new PassThrough();
        (out as any).__sse_responses.pipe(tee);
        tee.on('data', (chunk: Buffer) => { try { sseLogger.write(chunk.toString()).catch(()=>{}); } catch {} });
        tee.pipe(res);
      } catch {
        (out as any).__sse_responses.pipe(res);
      }
      return;
    }
    // 其次：客户端期待 SSE 但核心未给出流，按零回退输出最小错误帧
    if (wantsSSE) {
      stopPreHeartbeat();
      try {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control','no-cache, no-transform');
        res.setHeader('Connection','keep-alive');
        res.setHeader('X-Accel-Buffering','no');
      } catch {}
      try { const s = `data: ${JSON.stringify({ error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE' } })}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch {}
      try { const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{}); } catch {}
      try { res.end(); } catch {}
      return;
    }
    // Non‑SSE
    stopPreHeartbeat();
    try { await writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint }); } catch { /* ignore */ }
    res.status(200).json(out);
  } catch (error: any) {
    try {
      const expectsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || (req.body && (req.body as any).stream === true);
      if (expectsSSE) {
        try {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control','no-cache, no-transform');
          res.setHeader('Connection','keep-alive');
          res.setHeader('X-Accel-Buffering','no');
        } catch {}
        try { const s1 = `event: error\n`; const s2 = `data: ${JSON.stringify({ type:'error', error: { message: String(error?.message || 'Upstream error') } })}\n\n`; res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{}); } catch {}
        try { const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{}); } catch {}
        try { res.end(); } catch {}
        return;
      }
    } catch {}
    try { await writeServerSnapshot({ phase: 'http-response.error', requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, data: { message: error?.message || String(error) }, entryEndpoint }); } catch { /* ignore */ }
    if (!res.headersSent) res.status(500).json({ error: { message: error?.message || String(error) } });
  }
}

export default { handleMessages };
