/**
 * OpenAI Responses Handler
 * Handles OpenAI /v1/responses endpoint (stream + json)
 */

import express, { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ResponseNormalizer } from '../utils/response-normalizer.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { ResponsesConfigUtil } from '../config/responses-config.js';
import { ResponsesConverter } from '../conversion/responses-converter.js';
import { ResponsesMapper } from '../conversion/responses-mapper.js';
// Protocol conversion is handled downstream by llmswitch (Responses→Chat) for providers.
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Responses Handler
 * Handles /v1/responses endpoint (OpenAI Responses)
 */
export class ResponsesHandler extends BaseHandler {
  private requestValidator: RequestValidator;
  private responseNormalizer: ResponseNormalizer;
  private streamingManager: StreamingManager;

  constructor(config: ProtocolHandlerConfig) {
    super(config);
    this.requestValidator = new RequestValidator();
    this.responseNormalizer = new ResponseNormalizer();
    this.streamingManager = new StreamingManager(config);
  }

  /**
   * Handle responses request
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const moduleConfig = await ResponsesConfigUtil.load();
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    // Capture original request body and headers for later diff/debug
    try {
      const rawBody = JSON.parse(JSON.stringify((req as any).body || {}));
      (req as any).__rawBody = rawBody;
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'responses-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const rawFile = path.join(dir, `raw-request_${requestId}.json`);
      const payload = { requestId, method: req.method, url: req.originalUrl || req.url, headers: this.sanitizeHeaders(req.headers), body: rawBody };
      await (fs as any).writeFile(rawFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* ignore capture failures */ }

    this.logger.logModule(this.constructor.name, 'request_start', {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length || 0,
      maxTokens: req.body.max_tokens,
      streaming: req.body.stream || false,
      tools: !!req.body.tools,
      timestamp: startTime,
    });

    try {
      // Enforce Responses-shaped input: convert Chat/Anthropic to Responses fields and drop foreign fields
      try {
        const b: any = req.body || {};
        const out: any = {};
        // model / stream passthrough
        if (typeof b.model === 'string') out.model = b.model; else out.model = 'unknown';
        // Prefer explicit boolean; otherwise infer from Accept header
        const inferred = ResponsesConverter.inferStreamingFlag(b, req);
        if (typeof inferred === 'boolean') out.stream = inferred;
        if (typeof b.tools !== 'undefined') out.tools = b.tools;
        if (typeof b.tool_choice !== 'undefined') out.tool_choice = b.tool_choice;
        if (typeof b.parallel_tool_calls !== 'undefined') out.parallel_tool_calls = b.parallel_tool_calls;

        // Prefer existing Responses fields
        if (typeof b.instructions === 'string') out.instructions = b.instructions;
        if (typeof b.input !== 'undefined') out.input = b.input;

        // If Chat messages present, derive instructions/input
        if (Array.isArray(b.messages)) {
          let sys: string[] = [];
          let userTexts: string[] = [];
          for (const m of b.messages) {
            if (!m || typeof m !== 'object') continue;
            const role = (m as any).role;
            const content = (m as any).content;
            if (role === 'system' && typeof content === 'string' && content.trim()) sys.push(content.trim());
            if (role === 'user' && typeof content === 'string' && content.trim()) userTexts.push(content.trim());
            if (role === 'user' && Array.isArray(content)) {
              for (const part of content) {
                if (part && typeof part === 'object' && typeof (part as any).text === 'string' && (part as any).text.trim()) {
                  userTexts.push((part as any).text.trim());
                }
              }
            }
          }
          if (sys.length && !out.instructions) out.instructions = sys.join('\n\n');
          if (userTexts.length && typeof out.input === 'undefined') out.input = userTexts.join('\n');
        }

        // If still no input but Anthropic content exists, flatten to input
        if (typeof out.input === 'undefined' && Array.isArray(b.content)) {
          const texts: string[] = [];
          for (const c of b.content) {
            if (c && typeof c === 'object' && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string' && c.text.trim()) {
              texts.push(c.text.trim());
            }
          }
          if (texts.length) out.input = texts.join('\n');
        }

        // Finalize: drop foreign fields
        req.body = out;
        try { res.setHeader('x-rc-adapter', 'normalized:chat|anthropic->responses'); } catch { /* ignore */ }
      } catch { /* non-blocking */ }

      // Minimal validation for Responses-shaped request
      try {
        const b: any = req.body || {};
        if (!b.model || typeof b.model !== 'string') {
          throw new RouteCodexError('model field is required and must be a string', 'validation_error', 400);
        }
        if (typeof b.input === 'undefined' && typeof b.instructions === 'undefined') {
          throw new RouteCodexError('input or instructions is required for /v1/responses', 'validation_error', 400);
        }
      } catch (e) {
        throw e;
      }

      // Preserve original normalized request before pipeline mutates it
      const originalRequestSnapshot = JSON.parse(JSON.stringify(req.body || {}));

      // Process request through pipeline
      const response = await this.processResponseRequest(req, requestId);

      // Handle streaming vs non-streaming response
      if (req.body.stream) {
        await this.streamResponsesSSE(
          response,
          requestId,
          res,
          req.body.model,
          (req.body as any)?.tools,
          (req.body as any)?.tool_choice,
          (req.body as any)?.parallel_tool_calls,
          (req.body as any)?.instructions,
          originalRequestSnapshot
        );
        return;
      }

      // Return JSON response in OpenAI Responses format
      const normalized = await this.buildResponsesJson(
        response,
        {
          tools: (req.body as any)?.tools,
          tool_choice: (req.body as any)?.tool_choice,
          parallel_tool_calls: (req.body as any)?.parallel_tool_calls,
        }
      );
      try { res.setHeader('Content-Type', 'application/json'); } catch { /* ignore */ }
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process response request
   */
  private async processResponseRequest(req: Request, requestId: string): Promise<any> {
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }

    throw new RouteCodexError('Responses pipeline unavailable', 'pipeline_unavailable', 503);
  }

  /**
   * Process request through pipeline
   */
  private async processWithPipeline(req: Request, requestId: string): Promise<any> {
    const routeName = await this.decideRouteCategoryAsync(req);
    const pipelineId = this.pickPipelineId(routeName);
    const routeMeta = this.getRouteMeta();
    const meta = routeMeta ? routeMeta[pipelineId] : undefined;
    const providerId = meta?.providerId ?? 'unknown';
    const modelId = meta?.modelId ?? 'unknown';

    const pipelineRequest = {
      data: { ...(req.body as any || {}), ...(modelId ? { model: modelId } : {}) },
      route: {
        providerId,
        modelId,
        requestId,
        timestamp: Date.now(),
        pipelineId,
      },
      metadata: {
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        // Send OpenAI Chat to provider after local synth; targetProtocol=openai for safety
        targetProtocol: 'openai',
        endpoint: `${req.baseUrl || ''}${req.url || ''}`,
        entryEndpoint: '/v1/responses',
      },
      debug: {
        enabled: this.config.enableMetrics ?? true,
        stages: {
          llmSwitch: true,
          workflow: true,
          compatibility: true,
          provider: true,
        },
      },
    };

    // Debug: capture final request payload before entering pipeline (to diagnose client tolerance issues)
    try {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'responses-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `pre-pipeline_${requestId}.json`);
      await (fs as any).writeFile(file, JSON.stringify({ requestId, payload: pipelineRequest.data }, null, 2), 'utf-8');
    } catch { /* ignore */ }

    const pipelineTimeoutMs = Number(process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS || 300000);
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);
    const firstResp = (pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse)
      ? (pipelineResponse as Record<string, unknown>).data
      : pipelineResponse;

    // Debug: persist provider response for offline analysis
    try {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'responses-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `provider-response_${requestId}.json`);
      await (fs as any).writeFile(file, JSON.stringify(firstResp, null, 2), 'utf-8');
    } catch { /* ignore */ }

    // 工具调用仅由客户端执行；服务端不再尝试本地执行或发起第二轮。

    return firstResp;
  }

  /**
   * Stream SSE for Anthropic Responses endpoint with proper completion signal
   */
  private async streamResponsesSSE(
    response: any,
    requestId: string,
    res: Response,
    model?: string,
    reqTools?: unknown,
    reqToolChoice?: unknown,
    reqParallel?: unknown,
    reqInstructions?: unknown,
    reqMeta?: Record<string, unknown>
  ): Promise<void> {
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let streamAborted = false;
    // audit writer stub (initialized after fs paths are ready)
    let auditWrite: (kind: 'event' | 'meta' | 'end' | 'error', payload: Record<string, unknown>) => Promise<void> = async () => Promise.resolve();
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const baseDir = path.join(home || '', '.routecodex', 'codex-samples');
      const subDir = path.join(baseDir, 'responses-replay');
      const sseFile = path.join(subDir, `sse-events-${requestId}.log`);
      const sseAuditFile = path.join(subDir, `sse-audit-${requestId}.log`);
      const ensureDirs = async () => { try { await fs.mkdir(subDir, { recursive: true }); } catch { /* ignore */ } };
      const capture = async (event: string, data: unknown) => {
        try {
          await ensureDirs();
          const line = JSON.stringify({ ts: Date.now(), requestId, event, data }) + '\n';
          await fs.appendFile(sseFile, line, 'utf-8');
        } catch { /* ignore */ }
      };
      auditWrite = async (kind: 'event' | 'meta' | 'end' | 'error', payload: Record<string, unknown>) => {
        try {
          await ensureDirs();
          const now = new Date().toISOString();
          if (kind === 'event') {
            const ev = String((payload as any).event || 'unknown');
            const data = (payload as any).data !== undefined ? JSON.stringify((payload as any).data) : '{}';
            const chunk = `# ${now} requestId=${requestId}\n` +
                         `event: ${ev}\n` +
                         `data: ${data}\n\n`;
            await fs.appendFile(sseAuditFile, chunk, 'utf-8');
          } else if (kind === 'meta') {
            const chunk = `# ${now} requestId=${requestId} META ${JSON.stringify(payload)}\n`;
            await fs.appendFile(sseAuditFile, chunk, 'utf-8');
          } else if (kind === 'end') {
            const chunk = `# ${now} requestId=${requestId} SSE_END ${JSON.stringify(payload)}\n`;
            await fs.appendFile(sseAuditFile, chunk, 'utf-8');
          } else if (kind === 'error') {
            const chunk = `# ${now} requestId=${requestId} SSE_ERROR ${JSON.stringify(payload)}\n`;
            await fs.appendFile(sseAuditFile, chunk, 'utf-8');
          }
        } catch { /* ignore */ }
      };
      const startHeartbeat = async () => {
        const cfg = await ResponsesConfigUtil.load();
        const intervalMs = cfg.sse.heartbeatMs;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
          return;
        }
        heartbeatTimer = setInterval(() => {
          if (res.writableEnded) {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            return;
          }
          try {
            res.write(`: heartbeat ${Date.now()}\n\n`);
            void capture('heartbeat', { ts: Date.now() });
          } catch {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
          }
        }, intervalMs);
      };
      // Headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-request-id', requestId);
      await auditWrite('meta', { phase: 'headers', headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-request-id': requestId
      }});
      await startHeartbeat();

      // Minimal writer (OpenAI Responses standard) with sequence_number (start at 0)
      let seq = 0;
      const writeEvt = async (event: string, data: Record<string, unknown>) => {
        const payload = { ...(data || {}), sequence_number: seq++ } as Record<string, unknown>;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        try { await capture(event, payload); } catch { /* ignore */ }
        try { await auditWrite('event', { event, data: payload }); } catch { /* ignore */ }
      };

      const requestMeta = { ...(reqMeta ?? {}) } as Record<string, unknown>;
      const requestInstructions = typeof reqInstructions === 'string' ? reqInstructions : undefined;
      if (requestInstructions && !requestMeta.instructions) {
        requestMeta.instructions = requestInstructions;
      }
      if (reqTools !== undefined && requestMeta.tools === undefined) requestMeta.tools = reqTools;
      if (reqToolChoice !== undefined && requestMeta.tool_choice === undefined) requestMeta.tool_choice = reqToolChoice;
      if (reqParallel !== undefined && requestMeta.parallel_tool_calls === undefined) requestMeta.parallel_tool_calls = reqParallel;
      // If tool-followup is present, prefer __initial for tool events and __final for text/usage
      const rawInitial = (response && typeof response === 'object' && (response as any).__initial) ? (response as any).__initial : response;
      const rawFinal = (response && typeof response === 'object' && (response as any).__final) ? (response as any).__final : response;

      // Normalize both initial/final payloads into OpenAI Responses JSON via llmswitch
      const toResponsesShape = async (payload: any) => await ResponsesMapper.chatToResponsesFromMapping(payload);
      const initialResp = await toResponsesShape(rawInitial);
      const finalResp = await toResponsesShape(rawFinal);

      try {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
        const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'responses-replay');
        await (fs as any).mkdir(dir, { recursive: true });
        await (fs as any).writeFile(path.join(dir, `responses-initial_${requestId}.json`), JSON.stringify(initialResp, null, 2), 'utf-8');
        await (fs as any).writeFile(path.join(dir, `responses-final_${requestId}.json`), JSON.stringify(finalResp, null, 2), 'utf-8');
      } catch { /* ignore */ }

      const extractText = (resp: any): string => {
        const texts: string[] = [];
        const push = (s?: string) => { if (typeof s === 'string') { const t = s.trim(); if (t) texts.push(t); } };
        const walkBlocks = (blocks: any[]): void => {
          for (const b of blocks || []) {
            if (!b || typeof b !== 'object') continue;
            const t = (b as any).type;
            if ((t === 'text' || t === 'output_text') && typeof (b as any).text === 'string') { push((b as any).text); continue; }
            if (t === 'message' && Array.isArray((b as any).content)) { walkBlocks((b as any).content); continue; }
            if (Array.isArray((b as any).content)) { walkBlocks((b as any).content); }
          }
        };
        try {
          if (resp && typeof resp.output_text === 'string') push(resp.output_text);
          if (resp && Array.isArray(resp.output)) walkBlocks(resp.output);
          if (resp && Array.isArray(resp.content)) walkBlocks(resp.content);
          // Support Chat content as string or array-of-parts
          const chat = resp?.choices?.[0]?.message?.content;
          if (typeof chat === 'string') {
            push(chat);
          } else if (Array.isArray(chat)) {
            for (const part of chat) {
              if (part && typeof part === 'object') {
                if (typeof (part as any).text === 'string') { push((part as any).text); }
                else if (typeof (part as any).content === 'string') { push((part as any).content); }
              } else if (typeof part === 'string') { push(part); }
            }
          }
        } catch { /* ignore */ }
        return texts.join(' ');
      };

      // Use final response text if available; fallback to initial
      const textOut = extractText(finalResp) || extractText(initialResp);
      const words = (textOut || '').split(/\s+/g).filter(Boolean);

      const toCleanObject = (obj: Record<string, unknown>) => {
        for (const key of Object.keys(obj)) {
          if (obj[key] === undefined) delete obj[key];
        }
        return obj;
      };

      const assembleSnapshot = (): Record<string, unknown> => {
        const snap: Record<string, unknown> = { ...(finalResp || {}) };
        snap.id = snap.id || finalResp?.id || `resp_${requestId}`;
        snap.object = snap.object || 'response';
        const createdAt = (typeof snap.created_at === 'number' ? snap.created_at : undefined)
          ?? (typeof (snap as any).created === 'number' ? (snap as any).created : undefined)
          ?? Math.floor(Date.now() / 1000);
        snap.created_at = createdAt;
        delete (snap as any).created;
        snap.status = snap.status || 'completed';
        if (!('background' in snap)) snap.background = false;
        if (!('error' in snap)) snap.error = null;
        if (!('incomplete_details' in snap)) snap.incomplete_details = null;
        if (requestMeta.instructions && !snap.instructions) snap.instructions = requestMeta.instructions;
        if (requestMeta.reasoning && !snap.reasoning) snap.reasoning = requestMeta.reasoning;
        if (requestMeta.tool_choice && !snap.tool_choice) snap.tool_choice = requestMeta.tool_choice;
        if (requestMeta.parallel_tool_calls !== undefined && !snap.parallel_tool_calls) snap.parallel_tool_calls = requestMeta.parallel_tool_calls;
        if (requestMeta.tools && !snap.tools) snap.tools = requestMeta.tools;
        if (requestMeta.store !== undefined && !snap.store) snap.store = requestMeta.store;
        if (requestMeta.include && !snap.include) snap.include = requestMeta.include;
        if (requestMeta.prompt_cache_key && !snap.prompt_cache_key) snap.prompt_cache_key = requestMeta.prompt_cache_key;
        snap.model = model || snap.model || 'unknown';
        if (!snap.metadata) snap.metadata = {};
        if (!Array.isArray(snap.output) && Array.isArray(finalResp?.output)) snap.output = finalResp?.output;
        if (!('output_text' in snap)) snap.output_text = finalResp?.output_text ?? textOut ?? '';
        if (finalResp?.usage && !snap.usage) snap.usage = finalResp.usage;
        return toCleanObject(snap);
      };

      const baseSnapshot = assembleSnapshot();
      const baseResp = await ResponsesMapper.enrichResponsePayload(baseSnapshot, finalResp as Record<string, unknown>, requestMeta);
      const now = () => Math.floor(Date.now() / 1000);
      // Text strict Azure mode removed per rollback request; keep default text path

      // response.created / in_progress (OpenAI Responses shape)
      const createdTs = now();
      const inProgressResp = (() => {
        const snap = { ...baseResp, status: 'in_progress' } as Record<string, unknown>;
        delete snap.output;
        delete snap.output_text;
        delete snap.usage;
        delete snap.required_action;
        return toCleanObject(snap);
      })();

      await writeEvt('response.created', {
        type: 'response.created',
        response: { ...inProgressResp, created_at: createdTs }
      });
      await writeEvt('response.in_progress', {
        type: 'response.in_progress',
        response: { ...inProgressResp, created_at: createdTs }
      });

      // Emit reasoning item + summary parts (two summaries) to align with upstream shape
      try {
        const reasoningId = `rs_${requestId.replace(/[^a-zA-Z0-9]/g,'')}`;
        const randB64 = (len = 32) => {
          try { const c = require('crypto'); return c.randomBytes(len).toString('base64'); } catch { return Buffer.from(String(Date.now())).toString('base64'); }
        };
        // output_item.added(reasoning)
        await writeEvt('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: reasoningId, type: 'reasoning', encrypted_content: randB64(96), summary: [] }
        });
        const makeSummary = (seed?: string): string => {
          const s = (typeof seed === 'string' && seed.trim()) ? seed.trim() : 'Summarizing reasoning for the current turn.';
          return s.length > 480 ? s.slice(0, 480) : s;
        };
        const summary0 = makeSummary(typeof requestMeta?.instructions === 'string' ? String(requestMeta?.instructions) : undefined);
        const summary1 = makeSummary('Planning tool invocation and response formatting.');
        const chunk = async (text: string, summaryIndex: number) => {
          // part.added
          await writeEvt('response.reasoning_summary_part.added', {
            type: 'response.reasoning_summary_part.added',
            item_id: reasoningId,
            output_index: 0,
            summary_index: summaryIndex,
            part: { type: 'summary_text', text: '' }
          });
          // deltas with obfuscation placeholder
          const words = text.split(/\s+/g).filter(Boolean);
          let acc = '';
          for (const w of words) {
            acc += (acc ? ' ' : '') + w;
            if (acc.length >= 24) {
              await writeEvt('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta',
                item_id: reasoningId,
                output_index: 0,
                summary_index: summaryIndex,
                delta: acc,
                obfuscation: randB64(6)
              });
              acc = '';
            }
          }
          if (acc) {
            await writeEvt('response.reasoning_summary_text.delta', {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoningId,
              output_index: 0,
              summary_index: summaryIndex,
              delta: acc,
              obfuscation: randB64(6)
            });
          }
          // text.done
          await writeEvt('response.reasoning_summary_text.done', {
            type: 'response.reasoning_summary_text.done',
            item_id: reasoningId,
            output_index: 0,
            summary_index: summaryIndex,
            text
          });
          // part.done with final text
          await writeEvt('response.reasoning_summary_part.done', {
            type: 'response.reasoning_summary_part.done',
            item_id: reasoningId,
            output_index: 0,
            summary_index: summaryIndex,
            part: { type: 'summary_text', text }
          });
        };
        await chunk(summary0, 0);
        await chunk(summary1, 1);
      } catch { /* ignore reasoning stream synthesis */ }

      // Emit tool/function_call events after message, with output_index = 2
      // Assistant text deltas
      const hadToolFirstTurn = (
        (Array.isArray((initialResp as any)?.output) && (initialResp as any).output.some((x: any) => x && (x.type === 'tool_call' || x.type === 'function_call')))
        || (Array.isArray((initialResp as any)?.content) && (initialResp as any).content.some((x: any) => x?.type === 'tool_use'))
      );
      // 仅当确有文本时才发送 message 文本生命周期，避免空消息导致客户端误判重试
      if (words.length > 0) {
        // Emit item lifecycle gated by config
        const cfg = await ResponsesConfigUtil.load();
        if (cfg.sse.emitTextItemLifecycle) {
          const msgId = `msg_${requestId}`;
          await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
          await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 1, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } });
          for (const w of words) {
            await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 1, content_index: 0, delta: w + ' ', logprobs: [] });
            await new Promise(r => setTimeout(r, 12));
          }
          await writeEvt('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 1, content_index: 0, logprobs: [] });
          await writeEvt('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 1, content_index: 0 });
          await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { id: msgId, type: 'message', status: 'completed' } });
        } else {
          // Minimal text-only delta/done
          for (const w of words) {
            await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, item_id: `msg_${requestId}`, content_index: 0, delta: w + ' ', logprobs: [] });
            await new Promise(r => setTimeout(r, 12));
          }
          await writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 1, item_id: `msg_${requestId}`, content_index: 0, logprobs: [] });
        }
      }

      // After text/message, emit function_call stream if present (output_index = 2)
      try {
        const emitToolCallsFromResponsesOutput = async (resp: any) => {
          const out = Array.isArray(resp?.output) ? resp.output : [];
          for (const it of out) {
            if (!it || typeof it !== 'object') continue;
            if ((it as any).type === 'tool_call' || (it as any).type === 'function_call') {
              const id = (it as any).id || `call_${Math.random().toString(36).slice(2)}`;
              const call_id = (it as any).call_id || id;
              const name = (it as any).tool_name || (it as any).name || 'tool';
              const argsVal = (it as any).arguments ?? (it as any)?.tool_call?.function?.arguments ?? {};
              let argsStr = typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal);
              // Strict validation: do NOT normalize or fixup; if invalid vs schema, stream error and stop
              try {
                const error400 = (m: string) => { const e: any = new Error(m); (e as any).status = 400; (e as any).code = 'validation_error'; return e; };
                const ensureObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { normalizeTools } = require('../../modules/pipeline/modules/llmswitch/utils/tool-schema-normalizer.js');
                const toolsNorm = Array.isArray(reqTools) ? normalizeTools(reqTools) : [];
                const findSchema = (fnName?: string): Record<string, unknown> | undefined => {
                  if (!fnName || !Array.isArray(toolsNorm)) return undefined;
                  for (const t of toolsNorm) { const f: any = (t as any).function; if (f?.name === fnName) return f.parameters as Record<string, unknown>; }
                  return undefined;
                };
                const getKind = (schema: any, key: string): 'string'|'arrayString'|'object'|'any' => {
                  try {
                    const s = schema?.properties?.[key];
                    const t = s?.type; if (t === 'string') return 'string'; if (t === 'object') return 'object'; if (t === 'array' && s?.items?.type === 'string') return 'arrayString';
                  } catch {}
                  return 'any';
                };
                // Must be JSON string and object
                let parsed: any; try { parsed = JSON.parse(argsStr); } catch { throw error400('Tool call arguments must be valid JSON'); }
                if (!ensureObj(parsed)) throw error400('Tool call arguments must be a JSON object');
                const schema = findSchema(typeof name === 'string' ? name : undefined);
                if (schema && ensureObj((schema as any).properties)) {
                  const reqd: string[] = Array.isArray((schema as any).required) ? (schema as any).required as string[] : [];
                  for (const k of reqd) { if (!(k in parsed)) throw error400(`Missing required argument: ${k}`); }
                  for (const k of Object.keys((schema as any).properties)) {
                    if (!(k in parsed)) continue;
                    const kind = getKind(schema, k);
                    const val = (parsed as any)[k];
                    if (kind === 'string' && typeof val !== 'string') throw error400(`Invalid type for ${k}: expected string`);
                    if (kind === 'object' && !ensureObj(val)) throw error400(`Invalid type for ${k}: expected object`);
                    if (kind === 'arrayString' && (!Array.isArray(val) || !val.every((x: any) => typeof x === 'string'))) throw error400(`Invalid type for ${k}: expected array<string>`);
                  }
                }
              } catch (e) {
                const errMsg = (e as Error).message || 'Invalid tool call arguments';
                await writeEvt('response.error', { type: 'response.error', error: { message: errMsg, type: 'validation_error', code: 'ARGS_INVALID' }, requestId });
                await auditWrite('error', { phase: 'args_validation', message: errMsg, item_id: id, call_id, name });
                try { res.end(); } catch { /* ignore */ }
                if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                streamAborted = true;
                return;
              }
              // output_item.added(function_call)
              await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: 2, item: { id, type: 'function_call', status: 'in_progress', arguments: '', call_id, name } });
              await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: id, output_index: 2, content_index: 0, part: { type: 'input_json', partial_json: '' } });
              // chunk arguments
              const step = Math.max(1, Math.floor(String(argsStr).length / 3));
              for (let i = 0; i < String(argsStr).length; i += step) {
                const d = String(argsStr).slice(i, i + step);
                await writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: id, output_index: 2, delta: d });
              }
              await writeEvt('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: id, output_index: 2, arguments: String(argsStr), name });
              await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: 2, item: { id, type: 'function_call', status: 'completed', arguments: String(argsStr), call_id, name } });
            }
          }
        };
        const toolSource = finalResp && typeof finalResp === 'object' ? finalResp : {};
        await emitToolCallsFromResponsesOutput(toolSource);
        if (streamAborted) {
          // Tool args invalid and stream closed; stop further writes
          return;
        }
      } catch { /* ignore */ }

      // response.completed (attach total output_text when available)
      // Map usage from final turn if available
      const srcUsage = finalResp?.usage ? finalResp.usage : (initialResp?.usage ? initialResp.usage : undefined);
      const mapUsage = (u: any) => {
        if (!u || typeof u !== 'object') return undefined as unknown;
        const input = (typeof u.input_tokens === 'number') ? u.input_tokens
          : (typeof u.prompt_tokens === 'number') ? u.prompt_tokens
          : 0;
        const output = (typeof u.output_tokens === 'number') ? u.output_tokens
          : (typeof u.completion_tokens === 'number') ? u.completion_tokens
          : 0;
        const total = (typeof u.total_tokens === 'number') ? u.total_tokens : (input + output);
        return { input_tokens: input, output_tokens: output, total_tokens: total } as Record<string, number>;
      };
      const usage = mapUsage(srcUsage) as Record<string, number> | undefined;
      const completedSnapshot = { ...baseResp, status: 'completed' } as Record<string, unknown>;
      completedSnapshot.created_at = completedSnapshot.created_at ?? createdTs;
      if (!('output_text' in completedSnapshot) && textOut) {
        completedSnapshot.output_text = textOut;
      }
      if (!textOut) {
        delete completedSnapshot.output_text;
      }
      if (usage) completedSnapshot.usage = usage;
      // Ensure completed.output includes reasoning/message(function optional)/function_call in order
      try {
        const ensureCompletedOutput = () => {
          const list = Array.isArray((completedSnapshot as any).output) ? ((completedSnapshot as any).output as any[]) : [];
          const hasType = (t: string) => list.some(x => x && typeof x === 'object' && x.type === t);
          // seed reasoning summaries from earlier
          const reasoningItem = { type: 'reasoning', content: [ { type: 'summary_text', text: 'Summarizing reasoning for the current turn.' }, { type: 'summary_text', text: 'Planning tool invocation and response formatting.' } ] } as any;
          if (!hasType('reasoning')) list.unshift(reasoningItem);
          // message item from aggregated text (only when non-empty)
          if (textOut && textOut.trim()) {
            const msgItem = { type: 'message', message: { role: 'assistant', content: [ { type: 'output_text', text: textOut } ] } } as any;
            if (!hasType('message')) list.push(msgItem);
          }
          // function_call item exists from finalResp mapping; if missing, try to derive from finalResp (no status in completed snapshot)
          const addFunc = () => {
            const out = Array.isArray((finalResp as any)?.output) ? (finalResp as any).output : [];
            const it = out.find((x: any) => x && (x.type === 'function_call' || x.type === 'tool_call'));
            if (it) {
              list.push({
                type: 'function_call',
                id: it.id || `call_${Math.random().toString(36).slice(2,8)}`,
                call_id: it.call_id || it.id,
                name: it.name || it.tool_name || 'tool',
                arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})
              });
            }
          };
          if (!hasType('function_call')) addFunc();
          // If本轮已流式输出了 function_call.* 事件，则在 completed 快照中去掉 function_call 条目，避免客户端重复判定需要继续执行工具
          try {
            const toolStreamed = hadToolFirstTurn === true;
            if (toolStreamed) {
              const kept: any[] = [];
              for (const it of list) {
                if (it && typeof it === 'object' && it.type === 'function_call') continue;
                kept.push(it);
              }
              (completedSnapshot as any).output = kept;
              return;
            }
          } catch { /* ignore */ }
          // Normalize function_call items in completed snapshot: force status to 'completed' (or remove)
          for (const it of list) {
            if (it && typeof it === 'object' && (it.type === 'function_call')) {
              if (it.status && it.status !== 'completed') it.status = 'completed';
            }
          }
          (completedSnapshot as any).output = list;
        };
        ensureCompletedOutput();
      } catch { /* ignore */ }
      const completed = { type: 'response.completed', response: toCleanObject(completedSnapshot) } as Record<string, unknown>;
      if (streamAborted) { return; }
      await writeEvt('response.completed', completed);
      // no SSE audit summary when Azure artifacts removed
      try { res.end(); } catch { /* ignore */ }
      await auditWrite('end', { phase: 'completed' });
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    } catch (err) {
      try {
        const e = { type: 'response.error', error: { message: (err as Error).message || 'stream error', type: 'streaming_error', code: 'STREAM_FAILED' }, requestId } as Record<string, unknown>;
        res.write(`event: response.error\n`);
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch { /* ignore */ }
      await auditWrite('error', { message: (err as Error).message || String(err) });
      try { res.end(); } catch { /* ignore */ }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }

  /**
   * Build OpenAI Responses JSON for non-stream requests.
   * - Prefer __final if two-turn tool flow was used; else use single payload
   * - If payload already looks like Responses (object: 'response' or has output_text/output[]), return as-is
   * - Otherwise, convert Chat-style payload to Responses via llmswitch-response-chat
   */
  private async buildResponsesJson(raw: any, reqMeta?: { tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown }): Promise<any> {
    const pick = (v: any) => (v && typeof v === 'object' && v.__final) ? v.__final : v;
    const payload = pick(raw);
    try {
      if (payload && typeof payload === 'object') {
        if (payload.object === 'response' || Array.isArray((payload as any).output) || typeof (payload as any).output_text === 'string') {
          // 不合并任何服务器端工具结果；仅透传请求工具定义到 metadata
          if (reqMeta && typeof reqMeta === 'object' && payload && typeof payload === 'object') {
            const base: any = { ...(payload as any) };
            const meta: Record<string, unknown> = { ...(base.metadata || {}) };
            if (typeof reqMeta.tools !== 'undefined') {
              meta.tools = reqMeta.tools;
              try {
                const crypto = await import('crypto');
                const str = JSON.stringify(reqMeta.tools);
                const hash = crypto.createHash('sha256').update(str).digest('hex');
                (meta as any).tools_hash = hash;
                if (Array.isArray(reqMeta.tools)) (meta as any).tools_count = (reqMeta.tools as any[]).length;
              } catch { /* ignore */ }
            }
            if (typeof reqMeta.tool_choice !== 'undefined') meta.tool_choice = reqMeta.tool_choice;
            if (typeof reqMeta.parallel_tool_calls !== 'undefined') meta.parallel_tool_calls = reqMeta.parallel_tool_calls;
            base.metadata = meta;
            return await ResponsesMapper.enrichResponsePayload(base, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
          }
          return await ResponsesMapper.enrichResponsePayload(payload as Record<string, unknown>, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
        }
      }
    } catch { /* ignore */ }
    try {
      // Unified conversion: Chat JSON → Responses JSON via ResponsesMapper
      const converted = await ResponsesMapper.chatToResponsesFromMapping(payload);
      // Strict validation (no fallback): arguments must match declared tools schema
      const toolCallsPath = (converted as any)?.required_action?.submit_tool_outputs?.tool_calls;
      const reqTools = reqMeta?.tools as unknown;
      if (Array.isArray(toolCallsPath)) {
        const error400 = (m: string) => { const e: any = new Error(m); e.status = 400; e.code = 'validation_error'; return e; };
        const ensureObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
        // Optionally validate against provided tools schema when available
        let toolsNorm: Array<Record<string, unknown>> = [];
        if (Array.isArray(reqTools)) {
          try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { normalizeTools } = require('../../modules/pipeline/modules/llmswitch/utils/tool-schema-normalizer.js');
            toolsNorm = normalizeTools(reqTools as any[]);
          } catch { /* ignore tool schema load */ }
        }
        const findSchema = (fnName?: string): Record<string, unknown> | undefined => {
          if (!fnName || !toolsNorm.length) return undefined;
          for (const t of toolsNorm) {
            const f: any = (t as any).function;
            if (f && typeof f.name === 'string' && f.name === fnName) return f.parameters as Record<string, unknown>;
          }
          return undefined;
        };
        const getPropType = (schema: any, key: string): 'string'|'arrayString'|'object'|'any' => {
          try {
            const s = schema?.properties?.[key];
            const t = s?.type;
            if (t === 'string') return 'string';
            if (t === 'object') return 'object';
            if (t === 'array') {
              const it = s?.items?.type;
              if (it === 'string') return 'arrayString';
            }
          } catch { /* ignore */ }
          return 'any';
        };
        for (const tc of toolCallsPath) {
          if (!tc || typeof tc !== 'object' || !ensureObject((tc as any).function)) continue;
          const fn: any = (tc as any).function;
          const fnName = typeof fn.name === 'string' ? fn.name : undefined;
          if (typeof fn.arguments !== 'string') throw error400('Tool call arguments must be a JSON string');
          let argsObj: any;
          try { argsObj = JSON.parse(fn.arguments); } catch { throw error400('Tool call arguments must be valid JSON'); }
          if (!ensureObject(argsObj)) throw error400('Tool call arguments must be a JSON object');
          const schema = findSchema(fnName);
          if (schema && ensureObject(schema?.properties)) {
            // Enforce required keys when declared
            const required: string[] = Array.isArray((schema as any).required) ? (schema as any).required as string[] : [];
            for (const key of required) {
              if (!(key in argsObj)) throw error400(`Missing required argument: ${key}`);
            }
            for (const key of Object.keys((schema as any).properties)) {
              if (!(key in argsObj)) continue; // optional keys
              const kind = getPropType(schema, key);
              const val = argsObj[key];
              if (kind === 'string' && typeof val !== 'string') throw error400(`Invalid type for ${key}: expected string`);
              if (kind === 'object' && (!ensureObject(val))) throw error400(`Invalid type for ${key}: expected object`);
              if (kind === 'arrayString') {
                if (!Array.isArray(val) || !val.every((x: any) => typeof x === 'string')) throw error400(`Invalid type for ${key}: expected array<string>`);
              }
            }
          }
        }
      }
      return await ResponsesMapper.enrichResponsePayload(converted as Record<string, unknown>, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
    } catch {
      // Fallback minimal Responses wrapper
      const model = (payload && (payload as any).model) || 'unknown';
      const id = (payload && (payload as any).id) || `resp_${Date.now()}`;
      const text = (payload && (payload as any).choices && (payload as any).choices[0] && (payload as any).choices[0].message && typeof (payload as any).choices[0].message.content === 'string')
        ? (payload as any).choices[0].message.content
        : '';
      const base = { id, object: 'response', created: Math.floor(Date.now()/1000), model, status: 'completed', output: [], output_text: text };
      return await ResponsesMapper.enrichResponsePayload(base, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
    }
  }
}
