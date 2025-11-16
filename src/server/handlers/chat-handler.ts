import type { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { logNonBlockingError, runNonBlocking } from '../utils/non-blocking-error-logger.js';

// Chat endpoint: /v1/chat/completions (OpenAI Chat SSE shape)
export async function handleChatCompletions(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  // Per‑request SSE logger
  let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
  const entryEndpoint = '/v1/chat/completions';
  try {
    if (!ctx.pipelineManager) { res.status(503).json({ error: { message: 'Pipeline manager not attached' } }); return; }
    const payload = (req.body || {}) as any;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Snapshot: http-request（非阻塞，错误记录到内部日志）
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.http-request', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint })
    );
    const wantsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || payload.stream === true;

    // Attach endpoint metadata into payload for downstream selection（失败仅记录，不阻断请求）
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: wantsSSE };
    } catch (error) {
      await logNonBlockingError(
        { component: 'http.chat-handler', operation: 'payload.attach-metadata', requestId, entryEndpoint },
        error
      );
    }

    const routeName = await ctx.selectRouteName(payload, entryEndpoint);

    const sharedReq: any = {
      data: payload,
      route: { providerId: 'unknown', modelId: String(payload?.model || 'unknown'), requestId, timestamp: Date.now() },
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: wantsSSE, routeName },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };

    // SSE raw log sink
    sseLogger = (() => {
      try {
        const dir = path.join(os.homedir(), '.routecodex', 'logs', 'sse');
        const ensure = async () => {
          try {
            await fsp.mkdir(dir, { recursive: true });
          } catch (error) {
            await logNonBlockingError(
              { component: 'http.chat-handler', operation: 'sse.ensure-dir', requestId, entryEndpoint },
              error
            );
          }
        };
        const file = path.join(dir, `${requestId}_server.sse.log`);
        return {
          async write(s: string) {
            try {
              await ensure();
              await fsp.appendFile(file, `[${new Date().toISOString()}] ${s}`, 'utf-8');
            } catch (error) {
              await logNonBlockingError(
                { component: 'http.chat-handler', operation: 'sse.append-log', requestId, entryEndpoint },
                error
              );
            }
          }
        };
      } catch (error) {
        // 创建 SSE 日志失败时，仅记录内部错误，继续使用空 logger
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.logger-init', requestId, entryEndpoint },
          error
        );
        return { async write(_s: string) { /* noop */ } };
      }
    })();

    // Pre‑heartbeat for SSE
    let hbTimer: NodeJS.Timeout | null = null;
    const startPreHeartbeat = () => {
      try {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        (res as any).flushHeaders?.();
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.set-headers', requestId, entryEndpoint },
          error
        );
      }
      const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
      const writeBeat = () => {
        try {
          const s = `: pre-heartbeat ${Date.now()}\n\n`;
          res.write(s);
          sseLogger.write(s).catch(() => {});
        } catch (error) {
          void logNonBlockingError(
            { component: 'http.chat-handler', operation: 'sse.heartbeat', requestId, entryEndpoint, level: 'debug' },
            error
          );
        }
      };
      writeBeat();
      hbTimer = setInterval(writeBeat, iv);
    };
    const stopPreHeartbeat = () => {
      try {
        if (hbTimer) {
          clearInterval(hbTimer);
          hbTimer = null;
        }
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.heartbeat-stop', requestId, entryEndpoint, level: 'debug' },
          error
        );
      }
    };
    if (wantsSSE) startPreHeartbeat();

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.routing-selected', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'routing-selected', requestId, data: { routeName }, entryEndpoint })
    );
    const response = await ctx.pipelineManager.processRequest(sharedReq);
    const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
    // 优先：核心返回了 __sse_responses → 无条件按 SSE 输出（零回退）
    if (out && typeof out === 'object' && (out as any).__sse_responses) {
      try { console.log('[HTTP][SSE] piping core stream for /v1/chat/completions', { requestId }); } catch {}
      stopPreHeartbeat();
      try {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control','no-cache, no-transform');
        res.setHeader('Connection','keep-alive');
        res.setHeader('X-Accel-Buffering','no');
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.set-headers-core-stream', requestId, entryEndpoint },
          error
        );
      }
      try {
        const { PassThrough } = await import('node:stream');
        const tee = new PassThrough();
        (out as any).__sse_responses.pipe(tee);
        tee.on('data', (chunk: Buffer) => {
          try {
            sseLogger.write(chunk.toString()).catch(() => {});
          } catch (error) {
            void logNonBlockingError(
              { component: 'http.chat-handler', operation: 'sse.pipe-log', requestId, entryEndpoint },
              error
            );
          }
        });
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
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control','no-cache, no-transform');
        res.setHeader('Connection','keep-alive');
        res.setHeader('X-Accel-Buffering','no');
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.set-headers-fallback', requestId, entryEndpoint },
          error
        );
      }
      try {
        const s = `data: ${JSON.stringify({ error: { message: 'NO_CORE_SSE', code: 'NO_CORE_SSE' } })}\n\n`;
        res.write(s);
        sseLogger.write(s).catch(()=>{});
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.write-fallback', requestId, entryEndpoint },
          error
        );
      }
      try {
        const done = 'data: [DONE]\n\n';
        res.write(done);
        sseLogger.write(done).catch(()=>{});
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.chat-handler', operation: 'sse.write-fallback-done', requestId, entryEndpoint },
          error
        );
      }
      try { res.end(); } catch {}
      return;
    }
    // Non‑SSE
    stopPreHeartbeat();
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.http-response', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint })
    );
    res.status(200).json(out);
  } catch (error: any) {
    // SSE error path (zero fallback)
    try {
      const expectsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || (req.body && (req.body as any).stream === true);
      if (expectsSSE) {
        try {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control','no-cache, no-transform');
          res.setHeader('Connection','keep-alive');
          res.setHeader('X-Accel-Buffering','no');
        } catch (setErr) {
          void logNonBlockingError(
            { component: 'http.chat-handler', operation: 'sse.error.set-headers', entryEndpoint },
            setErr
          );
        }
        try {
          const s = `data: ${JSON.stringify({ error: { message: String(error?.message || 'Upstream error'), code: String((error as any)?.code || 'UPSTREAM_ERROR') } })}\n\n`;
          res.write(s);
          sseLogger.write(s).catch(()=>{});
        } catch (writeErr) {
          void logNonBlockingError(
            { component: 'http.chat-handler', operation: 'sse.error.write', entryEndpoint },
            writeErr
          );
        }
        try {
          const done = 'data: [DONE]\n\n';
          res.write(done);
          sseLogger.write(done).catch(()=>{});
        } catch (doneErr) {
          void logNonBlockingError(
            { component: 'http.chat-handler', operation: 'sse.error.write-done', entryEndpoint },
            doneErr
          );
        }
        try { res.end(); } catch {}
        return;
      }
    } catch {}
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.http-response-error', entryEndpoint },
      () => writeServerSnapshot({
        phase: 'http-response.error',
        requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        data: { message: error?.message || String(error) },
        entryEndpoint
      })
    );
    if (!res.headersSent) res.status(500).json({ error: { message: error?.message || String(error) } });
  }
}

export default { handleChatCompletions };
