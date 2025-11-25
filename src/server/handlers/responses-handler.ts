import type { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { logNonBlockingError, runNonBlocking } from '../utils/non-blocking-error-logger.js';

// Responses endpoint: /v1/responses (OpenAI Responses SSE with named events)
export async function handleResponses(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  let sseLogger: { write: (line: string) => Promise<void> } = { write: async () => {} } as any;
  const entryEndpoint = '/v1/responses';
  const payload = (req.body || {}) as any;
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
      // 对响应端点，明确标注 providerProtocol，避免蓝图误选 chat 链路
      payload.metadata = { ...meta, entryEndpoint, stream: wantsSSE, providerProtocol: 'openai-responses' };
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
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: wantsSSE, routeName, providerProtocol: 'openai-responses' },
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

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.routing-selected', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'routing-selected', requestId, data: { routeName }, entryEndpoint })
    );
    const response = await ctx.pipelineManager.processRequest(sharedReq);
    const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
    // 仅当核心返回了 __sse_responses 时，才以 SSE 输出
    if (out && typeof out === 'object' && (out as any).__sse_responses) {
      try { console.log('[HTTP][SSE] piping core stream for /v1/responses', { requestId }); } catch {}
      try {
        // 预心跳阶段已发送过 SSE 头，此处仅在尚未发送响应时补充，避免重复设置触发 ERR_HTTP_HEADERS_SENT
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control','no-cache');
          res.setHeader('Connection','keep-alive');
          res.setHeader('X-Accel-Buffering','no');
        }
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
    // 无核心SSE：统一按 JSON 返回（即使客户端声明 SSE）
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.http-response', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-response', requestId, data: out, entryEndpoint })
    );
    res.status(200).json(out);
  } catch (error: any) {
    // 错误：统一返回 JSON 错误
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
