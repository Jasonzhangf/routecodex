import type { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { getTransparentMonitorConfigForResponses } from '../utils/monitor-transparent.js';
import { logNonBlockingError, runNonBlocking } from '../utils/non-blocking-error-logger.js';

// Responses endpoint: /v1/responses (OpenAI Responses SSE with named events)
export async function handleResponses(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
  const entryEndpoint = '/v1/responses';
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = (req.body || {}) as any;

  // Transparent monitor mode: 直接透传到上游 /v1/responses（绕过本地流水线）
  const monitorCfg = getTransparentMonitorConfigForResponses();
  if (monitorCfg.enabled && monitorCfg.upstreamUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, monitorCfg.timeoutMs ?? 15000);

    try {
      await runNonBlocking(
        { component: 'http.responses-handler', operation: 'snapshot.monitor-upstream-request', requestId, entryEndpoint },
        () =>
          writeServerSnapshot({
            phase: 'monitor.upstream-request',
            requestId,
            data: {
              upstreamUrl: monitorCfg.upstreamUrl,
              timeoutMs: monitorCfg.timeoutMs ?? 15000,
              hasAuthHeader: !!monitorCfg.authHeader,
              payload
            },
            entryEndpoint
          })
      );

      const headers: Record<string, string> = {
        'content-type': 'application/json'
      };
      if (monitorCfg.authHeader) {
        headers['authorization'] = monitorCfg.authHeader;
      }

      const upstreamResp = await fetch(monitorCfg.upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal as any
      } as any);

      clearTimeout(timeout);

      const text = await upstreamResp.text();
      await runNonBlocking(
        { component: 'http.responses-handler', operation: 'snapshot.monitor-upstream-response', requestId, entryEndpoint },
        () =>
          writeServerSnapshot({
            phase: 'monitor.upstream-response',
            requestId,
            data: {
              status: upstreamResp.status,
              ok: upstreamResp.ok,
              headers: (() => {
                try {
                  const all: Record<string, string> = {};
                  upstreamResp.headers.forEach((v, k) => {
                    all[k] = v;
                  });
                  return all;
                } catch {
                  return {};
                }
              })(),
              bodyText: text
            },
            entryEndpoint
          })
      );
      const ct = upstreamResp.headers.get('content-type') || 'application/json; charset=utf-8';
      try {
        res.status(upstreamResp.status);
        res.setHeader('Content-Type', ct);
      } catch {
        // headers 已发送或响应已结束，尽力而为
      }
      try {
        res.send(text);
      } catch {
        // ignore send errors
      }
      await runNonBlocking(
        { component: 'http.responses-handler', operation: 'snapshot.monitor-http-response', requestId, entryEndpoint },
        () =>
          writeServerSnapshot({
            phase: 'monitor.http-response',
            requestId,
            data: {
              status: upstreamResp.status,
              contentType: ct,
              bodyText: text
            },
            entryEndpoint
          })
      );
      return;
    } catch (error: any) {
      clearTimeout(timeout);
      await runNonBlocking(
        { component: 'http.responses-handler', operation: 'snapshot.monitor-upstream-error', requestId, entryEndpoint },
        () =>
          writeServerSnapshot({
            phase: 'monitor.upstream-error',
            requestId,
            data: {
              message: error?.message || String(error),
              name: error?.name,
              code: (error as any)?.code
            },
            entryEndpoint
          })
      );
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: error?.message || String(error),
            type: 'monitor_upstream_error'
          }
        });
      }
      return;
    }
  }
  try {
    if (!ctx.pipelineManager) { res.status(503).json({ error: { message: 'Pipeline manager not attached' } }); return; }
    // Server-side parsed summary for inbound Responses payload（非阻塞）
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
    } catch (error) {
      await logNonBlockingError(
        { component: 'http.responses-handler', operation: 'snapshot.http-request-parsed', entryEndpoint },
        error
      );
    }
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Snapshot: http-request
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.http-request', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint })
    );
    const wantsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || payload.stream === true;
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: wantsSSE };
    } catch (error) {
      await logNonBlockingError(
        { component: 'http.responses-handler', operation: 'payload.attach-metadata', requestId, entryEndpoint },
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
    sseLogger = (() => {
      try {
        const dir = path.join(os.homedir(), '.routecodex', 'logs', 'sse');
        const ensure = async () => {
          try {
            await fsp.mkdir(dir, { recursive: true });
          } catch (error) {
            await logNonBlockingError(
              { component: 'http.responses-handler', operation: 'sse.ensure-dir', requestId, entryEndpoint },
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
                { component: 'http.responses-handler', operation: 'sse.append-log', requestId, entryEndpoint },
                error
              );
            }
          }
        };
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.responses-handler', operation: 'sse.logger-init', requestId, entryEndpoint },
          error
        );
        return { async write(_s: string) { /* noop */ } };
      }
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
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.responses-handler', operation: 'sse.set-headers', requestId, entryEndpoint },
          error
        );
      }
      const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
      const writeBeat = () => {
        try {
          const s = `: pre-heartbeat ${Date.now()}\n\n`;
          res.write(s);
          sseLogger.write(s).catch(()=>{});
        } catch (error) {
          void logNonBlockingError(
            { component: 'http.responses-handler', operation: 'sse.heartbeat', requestId, entryEndpoint, level: 'debug' },
            error
          );
        }
      };
      writeBeat(); hbTimer = setInterval(writeBeat, iv);
    };
    const stopPreHeartbeat = () => {
      try {
        if (hbTimer) {
          clearInterval(hbTimer);
          hbTimer = null;
        }
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.responses-handler', operation: 'sse.heartbeat-stop', requestId, entryEndpoint, level: 'debug' },
          error
        );
      }
    };
    if (wantsSSE) startPreHeartbeat();

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.routing-selected', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'routing-selected', requestId, data: { routeName }, entryEndpoint })
    );
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
      } catch (error) {
        void logNonBlockingError(
          { component: 'http.responses-handler', operation: 'sse.set-headers-fallback', requestId, entryEndpoint },
          error
        );
      }
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
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.http-response', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint })
    );
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
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.http-response-error', entryEndpoint },
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

export default { handleResponses };
