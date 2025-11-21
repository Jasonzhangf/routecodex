import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { getTransparentMonitorConfigForResponses } from '../utils/monitor-transparent.js';
import { logNonBlockingError, runNonBlocking } from '../utils/non-blocking-error-logger.js';
import { wantsSSE, createSSELogger, startPreHeartbeat, pipeUpstreamSSE, synthesizeResponsesSSE, sendResponsesSSEError } from '../utils/sse-utils.js';

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
    const expectsSSE = wantsSSE(req, payload);
    try {
      const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
      payload.metadata = { ...meta, entryEndpoint, stream: expectsSSE };
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
      metadata: { entryEndpoint, endpoint: entryEndpoint, stream: expectsSSE, routeName },
      debug: { enabled: false, stages: {} },
      entryEndpoint
    };
    sseLogger = createSSELogger(requestId, entryEndpoint);
    const stopPreHeartbeat = expectsSSE ? startPreHeartbeat(res, sseLogger) : () => {};

    // Snapshot: routing-selected（由虚拟路由器决策 routeName）
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.routing-selected', requestId, entryEndpoint },
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
      sendResponsesSSEError(res, 502, new Error('pipeline did not produce SSE stream'), sseLogger);
      stopPreHeartbeat();
      try { res.end(); } catch { /* ignore */ }
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
    // helper: extract http status from error object
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
    // SSE error path（入口为 SSE 时，无条件以 SSE 返回）
    try { if (wantsSSE(req, req.body)) { sendResponsesSSEError(res, extractStatus(error), error, sseLogger); return; } } catch { /* ignore */ }
    await runNonBlocking(
      { component: 'http.responses-handler', operation: 'snapshot.http-response-error', entryEndpoint },
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

export default { handleResponses };
