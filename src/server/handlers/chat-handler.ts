import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { logNonBlockingError, runNonBlocking } from '../utils/non-blocking-error-logger.js';
import {
  wantsSSE,
  setSSEHeaders,
  createSSELogger,
  startPreHeartbeat,
  pipeUpstreamSSE,
  sendChatSSEError,
  synthesizeChatSSE,
} from '../utils/sse-utils.js';
import { isEntryStreamingAllowed } from '../utils/streaming-flags.js';

// Chat endpoint: /v1/chat/completions (OpenAI Chat SSE shape)
export async function handleChatCompletions(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  let sseLogger = { write: async () => {} } as { write: (line: string) => Promise<void> };
  const entryEndpoint = '/v1/chat/completions';
  const streamingAllowed = isEntryStreamingAllowed(entryEndpoint);
  let clientRequestsSSE = false;
  let expectsSSE = false;
  try {
    if (!ctx.pipelineManager) { res.status(503).json({ error: { message: 'Pipeline manager not attached' } }); return; }
    const payload = (req.body || {}) as any;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // Snapshot: http-request（非阻塞，错误记录到内部日志）
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.http-request', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'http-request', requestId, data: payload, entryEndpoint })
    );
    clientRequestsSSE = wantsSSE(req, payload);
    expectsSSE = streamingAllowed && clientRequestsSSE;

    // Attach endpoint metadata into payload for downstream selection（失败仅记录，不阻断请求）
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: expectsSSE };
      if (!expectsSSE) {
        try { payload.stream = false; } catch { /* ignore */ }
      }
    } catch (error) {
      await logNonBlockingError(
        { component: 'http.chat-handler', operation: 'payload.attach-metadata', requestId, entryEndpoint },
        error
      );
    }

    const routing = await ctx.selectRouting(payload, entryEndpoint);
    const routeName = routing.routeName;

    const sharedReq: any = {
      data: payload,
      route: { providerId: 'unknown', modelId: String(payload?.model || 'unknown'), requestId, timestamp: Date.now(), ...(routing.pipelineId ? { pipelineId: routing.pipelineId } : {}) },
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: expectsSSE, routeName },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };

    sseLogger = createSSELogger(requestId, entryEndpoint);

    if (!streamingAllowed && clientRequestsSSE) {
      try { res.setHeader('X-RouteCodex-Streaming-Disabled', '1'); } catch { /* ignore */ }
    }

    // SSE pre-heartbeat
    const stopPreHeartbeat = expectsSSE ? startPreHeartbeat(res, sseLogger) : () => {};

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.routing-selected', requestId, entryEndpoint },
      () => writeServerSnapshot({ phase: 'routing-selected', requestId, data: { routeName }, entryEndpoint })
    );
    const response = await ctx.pipelineManager.processRequest(sharedReq);
    const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
    // 分支1：入口为 SSE 且核心返回 __sse_responses → 直通
    if (out && typeof out === 'object' && (out as any).__sse_responses) {
      stopPreHeartbeat();
      await pipeUpstreamSSE(res, (out as any).__sse_responses, sseLogger);
      return;
    }
    // 分支2：入口为 SSE 且非直通 → 不再在server合成，返回最小错误帧（合成由pipeline负责）
    if (expectsSSE) {
      sendChatSSEError(res, 502, new Error('pipeline did not produce SSE stream'), sseLogger);
      stopPreHeartbeat();
      try { res.end(); } catch { /* ignore */ }
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
    const extractStatus = (err: any): number => {
      try {
        const direct = Number(err?.statusCode || err?.status || err?.response?.status || NaN);
        if (Number.isFinite(direct) && direct >= 100 && direct <= 599) return direct;
        const candidates: string[] = [];
        if (typeof err?.code === 'string') candidates.push(err.code);
        if (typeof err?.name === 'string') candidates.push(err.name);
        if (typeof err?.message === 'string') candidates.push(err.message);
        try { if (typeof err?.response?.data?.error?.code === 'string') candidates.push(String(err.response.data.error.code)); } catch {}
        try { if (typeof err?.response?.data?.error?.message === 'string') candidates.push(String(err.response.data.error.message)); } catch {}
        for (const s of candidates) {
          const m = String(s).match(/\b(\d{3})\b/);
          if (m) { const n = Number(m[1]); if (n >= 100 && n <= 599) return n; }
        }
      } catch {}
      return 500;
    };
    // SSE error path（仅在当前入口允许且客户端请求时采用 SSE 返回）
    try { if (expectsSSE) { sendChatSSEError(res, extractStatus(error), error, sseLogger); return; } } catch { /* ignore */ }
    await runNonBlocking(
      { component: 'http.chat-handler', operation: 'snapshot.http-response-error', entryEndpoint },
      () => writeServerSnapshot({
        phase: 'http-response.error',
        requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        data: { message: error?.message || String(error) },
        entryEndpoint
      })
    );
    if (!res.headersSent) {
      const status = extractStatus(error);
      res.status(status).json({ error: { message: error?.message || String(error), code: (error as any)?.code || undefined } });
    }
  }
}

export default { handleChatCompletions };
