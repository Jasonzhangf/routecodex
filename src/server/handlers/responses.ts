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
import { buildResponsesPayloadFromChat } from '@routecodex/llmswitch-core/conversion';
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
      // 仅改变格式，不清洗/丢弃字段：基于原始请求体派生 Responses 关键字段并回写，保留全部原字段
      try {
        const b: any = req.body || {};
        const merged: any = { ...b };
        // model：如缺失则置为 unknown（不强行覆盖已有值）
        if (typeof merged.model !== 'string' || !merged.model) {
          merged.model = 'unknown';
        }
        // stream：仅当未显式给出时，按 Accept 头推断
        if (typeof merged.stream !== 'boolean') {
          const inferred = ResponsesConverter.inferStreamingFlag(b, req);
          if (typeof inferred === 'boolean') merged.stream = inferred;
        }
        // 若原本没有 instructions/input，则尝试从 Chat 形状派生
        if (typeof merged.instructions !== 'string' || merged.instructions.trim() === '') {
          if (Array.isArray(b.messages)) {
            const sys: string[] = [];
            for (const m of b.messages) {
              if (!m || typeof m !== 'object') continue;
              const role = (m as any).role;
              const content = (m as any).content;
              if (role === 'system' && typeof content === 'string' && content.trim()) sys.push(content.trim());
            }
            if (sys.length) merged.instructions = sys.join('\n\n');
          }
        }
        if (typeof merged.input === 'undefined' || (typeof merged.input === 'string' && merged.input.trim() === '')) {
          if (Array.isArray(b.messages)) {
            const userTexts: string[] = [];
            for (const m of b.messages) {
              if (!m || typeof m !== 'object') continue;
              const role = (m as any).role;
              const content = (m as any).content;
              if (role === 'user' && typeof content === 'string' && content.trim()) userTexts.push(content.trim());
              if (role === 'user' && Array.isArray(content)) {
                for (const part of content) {
                  if (part && typeof part === 'object' && typeof (part as any).text === 'string' && (part as any).text.trim()) {
                    userTexts.push((part as any).text.trim());
                  }
                }
              }
            }
            if (userTexts.length) merged.input = userTexts.join('\n');
          }
          // Anthropic content 兼容
          if (typeof merged.input === 'undefined' && Array.isArray(b.content)) {
            const texts: string[] = [];
            for (const c of b.content) {
              if (c && typeof c === 'object' && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string' && c.text.trim()) {
                texts.push(c.text.trim());
              }
            }
            if (texts.length) merged.input = texts.join('\n');
          }
        }

        req.body = merged; // 不移除任何原字段
        try { res.setHeader('x-rc-adapter', 'normalized:chat|anthropic->responses:non-lossy'); } catch { /* ignore */ }
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

      // Normalize both initial/final payloads into OpenAI Responses JSON (passthrough if already Responses)
      const toResponsesShape = async (payload: any) => {
        if (payload && typeof payload === 'object' && (payload as any).object === 'response') {
          return payload as Record<string, unknown>;
        }
        // Use core codec to avoid duplicate mapping logic
        return buildResponsesPayloadFromChat(payload, undefined) as Record<string, unknown>;
      };
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
        // Preserve paragraph/line breaks when aggregating text parts
        return texts.join('\n');
      };

      // Use final response text if available; fallback to initial
      let textOut = extractText(finalResp) || extractText(initialResp);
      // Collapse excessive consecutive newlines to at most two (paragraph break)
      if (typeof textOut === 'string') {
        textOut = textOut.replace(/\n{3,}/g, '\n\n');
      }
      // Preserve newlines during streaming by splitting into newline-aware segments
      const words = (textOut || '')
        .split(/(\n+)/g)
        .map((s: string) => (/^\n+$/.test(s) ? '\n' : s))
        .filter((s: string) => s.length > 0);

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
        // Prefer provider-reported model; only fallback to request model when missing
        snap.model = (snap.model as string) || (model as string) || 'unknown';
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

      // 如果是工具调用场景：按透传方式流 function_call 参数增量并最终发送 completed（SSE 不发送 required_action）
      const raExisting = (initialResp as any)?.required_action || (finalResp as any)?.required_action;
      const getFunctionCalls = (resp: any): any[] => {
        const out = Array.isArray(resp?.output) ? resp.output : [];
        return out.filter((it: any) => it && (it.type === 'function_call' || it.type === 'tool_call'));
      };
      const deriveRequiredAction = (funcCalls: any[]): Record<string, unknown> | null => {
        if (!Array.isArray(funcCalls) || funcCalls.length === 0) return null;
        const toStringArgs = (v: any): string => {
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
        };
        const calls = funcCalls.map((it: any) => {
          const id = typeof it.id === 'string' ? it.id : (typeof it.call_id === 'string' ? it.call_id : `call_${Math.random().toString(36).slice(2,8)}`);
          const name = typeof it.name === 'string' ? it.name : (typeof it.tool_name === 'string' ? it.tool_name : (it?.function?.name || 'tool'));
          const argsVal = it.arguments ?? it?.function?.arguments ?? {};
          const argsStr = toStringArgs(argsVal);
          return { id, type: 'function', function: { name: String(name), arguments: String(argsStr) } };
        });
        return { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: calls } } as Record<string, unknown>;
      };
      const funcCalls = getFunctionCalls(finalResp) as any[];
      if (Array.isArray(funcCalls) && funcCalls.length > 0) {
        // Stream function_call lifecycle and arguments deltas
        const toArgsStr = (v: any) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } })());
        const canonicalizeTool = (name: string | undefined, argsStr: string): { name: string; args: string } => {
          const whitelist = new Set(['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);
          if (!name || typeof name !== 'string') return { name: 'tool', args: argsStr };
          const dot = name.indexOf('.');
          if (dot <= 0) return { name, args: argsStr };
          const prefix = name.slice(0, dot).trim();
          const base = name.slice(dot + 1).trim();
          if (!whitelist.has(base)) return { name, args: argsStr };
          let obj: any;
          try { obj = JSON.parse(argsStr || '{}'); } catch { obj = {}; }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
          if (obj.server == null || obj.server === '') obj.server = prefix;
          return { name: base, args: JSON.stringify(obj) };
        };
        let outIndex = 0;
        for (const it of funcCalls) {
          const id = typeof it.id === 'string' ? it.id : (typeof it.call_id === 'string' ? it.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
          const call_id = typeof it.call_id === 'string' ? it.call_id : id;
          const rawName = typeof it.name === 'string' ? it.name : (typeof it.tool_name === 'string' ? it.tool_name : (it?.function?.name || 'tool'));
          const rawArgs = toArgsStr(it.arguments ?? it?.function?.arguments ?? {});
          const { name, args: argsStr } = canonicalizeTool(rawName, rawArgs);
          await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: outIndex, item: { id, type: 'function_call', status: 'in_progress', arguments: '', call_id, name } });
          await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: id, output_index: outIndex, content_index: 0, part: { type: 'input_json', partial_json: '' } });
          // arguments deltas
          const parts = Math.max(3, Math.min(12, Math.ceil(argsStr.length / 8)));
          const step = Math.max(1, Math.ceil(argsStr.length / parts));
          for (let i = 0; i < argsStr.length; i += step) {
            const d = argsStr.slice(i, i + step);
            await writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: id, output_index: outIndex, delta: d });
          }
          await writeEvt('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: id, output_index: outIndex, arguments: String(argsStr) });
          await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: outIndex, item: { id, type: 'function_call', status: 'completed', arguments: String(argsStr), call_id, name } });
          outIndex += 1;
        }
        // After function_call streaming, emit completed and close
        const srcUsage2 = finalResp?.usage ? finalResp.usage : (initialResp?.usage ? initialResp.usage : undefined);
        const usage2 = (() => {
          if (!srcUsage2 || typeof srcUsage2 !== 'object') return undefined as unknown as Record<string, number> | undefined;
          const input = (typeof (srcUsage2 as any).input_tokens === 'number') ? (srcUsage2 as any).input_tokens : (typeof (srcUsage2 as any).prompt_tokens === 'number' ? (srcUsage2 as any).prompt_tokens : 0);
          const output = (typeof (srcUsage2 as any).output_tokens === 'number') ? (srcUsage2 as any).output_tokens : (typeof (srcUsage2 as any).completion_tokens === 'number' ? (srcUsage2 as any).completion_tokens : 0);
          const total = (typeof (srcUsage2 as any).total_tokens === 'number') ? (srcUsage2 as any).total_tokens : (input + output);
          return { input_tokens: input, output_tokens: output, total_tokens: total } as Record<string, number>;
        })();
        const completedSnapshot2 = { ...baseResp, status: 'completed' } as Record<string, unknown>;
        completedSnapshot2.created_at = completedSnapshot2.created_at ?? createdTs;
        if (usage2) completedSnapshot2.usage = usage2;
        const completed2 = { type: 'response.completed', response: toCleanObject(completedSnapshot2) } as Record<string, unknown>;
        await writeEvt('response.completed', completed2);
        try { res.end(); } catch { /* ignore */ }
        await auditWrite('end', { phase: 'completed_after_function_call' });
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        return;
      }

      // 文本直出：仅输出 output_text.delta/done（不做额外 reasoning/message 合成）
      if (words.length > 0) {
        for (const w of words) {
          const delta = /^\n+$/.test(w) ? '\n' : w;
          await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta, logprobs: [] });
          await new Promise(r => setTimeout(r, 12));
        }
        await writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, logprobs: [] });
      }

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
      // Ensure completed.output 仅包含聚合文本（如存在）；不注入 reasoning/function_call 条目
      try {
        const list: any[] = [];
        if (textOut && textOut.trim()) {
          list.push({ type: 'message', message: { role: 'assistant', content: [ { type: 'output_text', text: textOut } ] } });
        }
        (completedSnapshot as any).output = list;
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
      // Core codec: Chat JSON → Responses JSON (strict,无兜底)
      const converted0 = buildResponsesPayloadFromChat(payload, undefined) as Record<string, unknown>;

      // Synthesize required_action for non-stream JSON when存在 function_call 输出
      const outputs = Array.isArray((converted0 as any)?.output) ? ((converted0 as any).output as any[]) : [];
      const funcCalls = outputs.filter(it => it && (it.type === 'function_call' || it.type === 'tool_call'));
      let converted = converted0;
      if (funcCalls.length > 0) {
        const toStringJson = (v: unknown): string => {
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
        };
        // Schema-aware validation (no fallback)
        const reqTools = reqMeta?.tools as unknown;
        let toolsNorm: Array<Record<string, unknown>> = [];
        if (Array.isArray(reqTools)) {
          try {
            const mod = await import('@routecodex/llmswitch-core/conversion');
            const fn = (mod as any).normalizeTools as ((t: any[]) => Array<Record<string, unknown>>);
            if (typeof fn === 'function') toolsNorm = fn(reqTools as any[]);
          } catch { /* ignore */ }
        }
        const findSchema = (fnName?: string): Record<string, unknown> | undefined => {
          if (!fnName || !toolsNorm.length) return undefined;
          for (const t of toolsNorm) {
            const f: any = (t as any).function;
            if (f && typeof f.name === 'string' && f.name === fnName) return f.parameters as Record<string, unknown>;
          }
          return undefined;
        };
        const ensureObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
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
        const error400 = (m: string) => { const e: any = new Error(m); e.status = 400; e.code = 'validation_error'; return e; };

        const calls = funcCalls.map((it: any) => {
          const id = typeof it.id === 'string' ? it.id : (typeof it.call_id === 'string' ? it.call_id : `call_${Math.random().toString(36).slice(2,8)}`);
          const nm = typeof it.name === 'string' ? it.name : (typeof it?.function?.name === 'string' ? it.function.name : 'tool');
          const rawArgs = it.arguments ?? it?.function?.arguments ?? {};
          const argsStr = toStringJson(rawArgs);
          // Validate
          if (toolsNorm.length > 0) {
            const schema = findSchema(nm);
            if (schema && ensureObject(schema?.properties)) {
              let argsObj: any;
              try { argsObj = JSON.parse(argsStr); } catch { throw error400('Tool call arguments must be valid JSON'); }
              if (!ensureObject(argsObj)) throw error400('Tool call arguments must be a JSON object');
              const required: string[] = Array.isArray((schema as any).required) ? (schema as any).required as string[] : [];
              for (const key of required) {
                if (!(key in argsObj)) throw error400(`Missing required argument: ${key}`);
              }
              for (const key of Object.keys((schema as any).properties)) {
                if (!(key in argsObj)) continue;
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
          return { id, type: 'function', function: { name: String(nm), arguments: String(argsStr) } };
        });
        converted = { ...(converted0 as any), required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: calls } } };
      }

      return await ResponsesMapper.enrichResponsePayload(converted as Record<string, unknown>, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
    } catch (e) {
      // 不允许 fallback：严格报错，便于定位转换问题
      const msg = (e as Error)?.message || 'Responses conversion failed (Chat→Responses)';
      const err = new RouteCodexError(msg, 'conversion_error', 400);
      throw err;
    }
  }
}
