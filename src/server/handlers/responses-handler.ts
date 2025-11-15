import type { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';

// Responses endpoint: /v1/responses (OpenAI Responses SSE with named events)
export async function handleResponses(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
  const entryEndpoint = '/v1/responses';
  try {
    if (!ctx.pipelineManager) { res.status(503).json({ error: { message: 'Pipeline manager not attached' } }); return; }
    const payload = (req.body || {}) as any;
    // Server-side parsed summary for inbound Responses payload
    try {
      const summarize = (p: any) => {
        const input = Array.isArray(p?.input) ? p.input : [];
        const inputSummary = input.map((it: any) => {
          const role = String((it?.role || 'user')).toLowerCase();
          const type = String((it?.type || 'message')).toLowerCase();
          const blocks = Array.isArray(it?.content) ? it.content : [];
          const blockTypes: Record<string, number> = {};
          for (const b of blocks) {
            const bt = String((b?.type || 'text')).toLowerCase();
            blockTypes[bt] = (blockTypes[bt] || 0) + 1;
          }
          return { role, type, blocks: blockTypes };
        });
        const tools = Array.isArray(p?.tools) ? p.tools.length : 0;
        const meta = (p?.metadata && typeof p.metadata === 'object') ? p.metadata : undefined;
        return {
          model: p?.model,
          hasInstructions: typeof p?.instructions === 'string' && p.instructions.length > 0,
          inputCount: input.length,
          inputSummary,
          toolsCount: tools,
          toolChoice: p?.tool_choice,
          parallelToolCalls: p?.parallel_tool_calls,
          stream: p?.stream === true,
          client_request_id: meta?.client_request_id
        };
      };
      await writeServerSnapshot({ phase: 'http-request.parsed', requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2,10)}`, data: summarize(payload), entryEndpoint });
    } catch { /* ignore */ }
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Snapshot: http-request
    try { await writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint }); } catch { /* non-blocking */ }
    const wantsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || payload.stream === true;
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: wantsSSE };
    } catch { /* ignore */ }

    const routeName = await ctx.selectRouteName(payload, entryEndpoint);
    const sharedReq: any = {
      data: payload,
      route: { providerId: 'unknown', modelId: String(payload?.model || 'unknown'), requestId, timestamp: Date.now() },
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: wantsSSE, routeName },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };
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

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    try { await writeServerSnapshot({ phase: 'routing-selected', requestId, data: { routeName }, entryEndpoint }); } catch { /* ignore */ }
    const response = await ctx.pipelineManager.processRequest(sharedReq);
    const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
    // 优先：核心返回了 __sse_responses → 无条件按 SSE 输出（零回退）
    if (out && typeof out === 'object' && (out as any).__sse_responses) {
      try { console.log('[HTTP][SSE] piping core stream for /v1/responses', { requestId }); } catch {}
      stopPreHeartbeat();
      try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control','no-cache');
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
    // 其次：客户端期待 SSE 但核心未给出流 → 输出最小错误帧 + [DONE]
    if (wantsSSE) {
      stopPreHeartbeat();
      try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control','no-cache');
        res.setHeader('Connection','keep-alive');
        res.setHeader('X-Accel-Buffering','no');
      } catch {}
      try {
        const s1 = `event: response.error\n`;
        const s2 = `data: ${JSON.stringify({ type:'response.error', error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE', type: 'pipeline_error' } })}\n\n`;
        res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{});
        const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
      } catch {}
      try { res.end(); } catch {}
      return;
    }
    // Non-SSE
    stopPreHeartbeat();
    try { await writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint }); } catch { /* ignore */ }
    res.status(200).json(out);
  } catch (error: any) {
    // SSE error path
    try {
      const expectsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || (req.body && (req.body as any).stream === true);
      if (expectsSSE) {
        try { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); } catch {}
        try {
          const s1 = `event: response.error\n`;
          const s2 = `data: ${JSON.stringify({ type:'response.error', error: { message: String(error?.message || 'Upstream error'), code: String((error as any)?.code || 'UPSTREAM_ERROR'), type: 'upstream_error' } })}\n\n`;
          res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{});
          const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
        } catch {}
        try { res.end(); } catch {}
        return;
      }
    } catch {}
    try { await writeServerSnapshot({ phase: 'http-response.error', requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, data: { message: error?.message || String(error) }, entryEndpoint }); } catch { /* ignore */ }
    if (!res.headersSent) res.status(500).json({ error: { message: error?.message || String(error) } });
  }
}

export default { handleResponses };
