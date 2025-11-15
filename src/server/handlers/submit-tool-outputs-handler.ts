import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';

// Shared handler for OpenAI Responses continuation:
// POST /v1/responses/:id/submit_tool_outputs
// Accepts { tool_outputs: [{ tool_call_id, output }], stream?: boolean, model?: string }
// Maps to next-round Responses request: { model, input: [{ type:'tool_result', tool_call_id, output }], stream:true, previous_response_id }
export async function handleSubmitToolOutputs(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
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

    // Best-effort: if model is absent, try infer from codex-samples snapshot by response id
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

    const input = toolOutputs.map((t: any) => ({
      type: 'tool_result',
      tool_call_id: String((t && (t.tool_call_id || t.call_id || t.id)) || ''),
      output: (t && t.output != null) ? String(t.output) : ''
    }));
    const payload = { model: model || 'unknown', input, stream: true, previous_response_id: responseId } as any;

    if (!ctx.pipelineManager) {
      return emitErrorSSE('Pipeline manager not attached', model || 'unknown');
    }

    try {
      const routeName = await ctx.selectRouteName(payload, '/v1/responses');
      const sharedReq = {
        data: payload,
        route: { providerId: 'unknown', modelId: String(payload.model||'unknown'), requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, timestamp: Date.now() },
        metadata: { entryEndpoint: '/v1/responses', endpoint: '/v1/responses', stream: wantsSSE, routeName },
        debug: { enabled: false, stages: {} }
      } as any;
      const response = await (ctx.pipelineManager as any).processRequest(sharedReq);
      const out = (response && typeof response === 'object' && 'data' in response) ? (response as any).data : response;
      if (wantsSSE) {
        if (out && typeof out === 'object' && (out as any).__sse_responses) {
          try { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); } catch {}
          (out as any).__sse_responses.pipe(res); return;
        }
        if (String(process.env.ROUTECODEX_SERVER_SSE_FALLBACK || '0') === '1') {
          // legacy, discouraged
          const text = input.map((i: any) => i.output).join('\n');
          const modelStr = String(payload.model||'unknown');
          return emitErrorSSE(text || 'Tool outputs submitted (server-fallback).', modelStr);
        }
        return emitErrorSSE('Core did not produce Responses SSE stream', String(payload.model||'unknown'));
      } else {
        res.status(200).json(out); return;
      }
    } catch (err: any) {
      const msg = String(err?.message || 'Upstream or pipeline error');
      return emitErrorSSE(msg, model || 'unknown');
    }
  } catch (error: any) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    res.status(status).json({ error: { message: error?.message || String(error) } });
  }
}

export default { handleSubmitToolOutputs };
