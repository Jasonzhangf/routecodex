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
import { buildResponsesPayloadFromChat, normalizeTools } from 'rcc-llmswitch-core/api';
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
      try { res.setHeader('x-rc-conversion-profile', 'responses-openai'); } catch { /* ignore */ }
      // 可选：受控的“静态”系统提示注入（默认关闭），优先写入 instructions 字段
      // 禁止样本抓取式注入；仅当明确配置 ROUTECODEX_ENABLE_SERVER_SYSTEM_PROMPT=1 且提供
      // ROUTECODEX_SERVER_SYSTEM_PROMPT=</path/to/prompt.txt> 时，才在 instructions 为空时写入。
      try {
        const enable = String(process.env.ROUTECODEX_ENABLE_SERVER_SYSTEM_PROMPT || '0') === '1';
        const filePath = String(process.env.ROUTECODEX_SERVER_SYSTEM_PROMPT || '').trim();
        if (enable && filePath) {
          const fs = await import('fs/promises');
          const sysText = await fs.readFile(filePath, 'utf-8');
          const instr = typeof (req.body as any)?.instructions === 'string' ? String((req.body as any).instructions) : '';
          const hasMdMarkers = /\bCLAUDE\.md\b|\bAGENT(?:S)?\.md\b/i.test(instr);
          if (!hasMdMarkers && (!instr || !instr.trim())) {
            (req.body as any).instructions = sysText;
            try { res.setHeader('x-rc-system-prompt-source', 'static-file'); } catch { /* ignore */ }
          }
        }
      } catch { /* non-blocking */ }

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
          if (typeof inferred === 'boolean') {merged.stream = inferred;}
        }
        // 若原本没有 instructions/input，则尝试从 Chat 形状派生
        if (typeof merged.instructions !== 'string' || merged.instructions.trim() === '') {
          if (Array.isArray(b.messages)) {
            const sys: string[] = [];
            for (const m of b.messages) {
              if (!m || typeof m !== 'object') {continue;}
              const role = (m as any).role;
              const content = (m as any).content;
              if (role === 'system' && typeof content === 'string' && content.trim()) {sys.push(content.trim());}
            }
            if (sys.length) {merged.instructions = sys.join('\n\n');}
          }
        }
        if (typeof merged.input === 'undefined' || (typeof merged.input === 'string' && merged.input.trim() === '')) {
          if (Array.isArray(b.messages)) {
            const userTexts: string[] = [];
            for (const m of b.messages) {
              if (!m || typeof m !== 'object') {continue;}
              const role = (m as any).role;
              const content = (m as any).content;
              if (role === 'user' && typeof content === 'string' && content.trim()) {userTexts.push(content.trim());}
              if (role === 'user' && Array.isArray(content)) {
                for (const part of content) {
                  if (part && typeof part === 'object' && typeof (part as any).text === 'string' && (part as any).text.trim()) {
                    userTexts.push((part as any).text.trim());
                  }
                }
              }
            }
            if (userTexts.length) {merged.input = userTexts.join('\n');}
          }
          // Anthropic content 兼容
          if (typeof merged.input === 'undefined' && Array.isArray(b.content)) {
            const texts: string[] = [];
            for (const c of b.content) {
              if (c && typeof c === 'object' && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string' && c.text.trim()) {
                texts.push(c.text.trim());
              }
            }
            if (texts.length) {merged.input = texts.join('\n');}
          }
        }

        req.body = merged; // 不移除任何原字段
        try { res.setHeader('x-rc-adapter', 'normalized:chat|anthropic->responses:non-lossy'); } catch { /* ignore */ }
      } catch { /* non-blocking */ }

      // Tool guidance and normalization are handled in llmswitch-core (openai tooling stage)

      // Remove strict request validation for Responses-shaped requests (preserve raw body)

      // Preserve original normalized request before pipeline mutates it
      const originalRequestSnapshot = JSON.parse(JSON.stringify(req.body || {}));

      // Process request through pipeline
      const response = await this.processResponseRequest(req, requestId);

      // Handle streaming vs non-streaming response（保留“合成流”以兼容 Responses 客户端）
      if (req.body.stream) {
        // Prefer true streaming bridge when upstream returns a Readable and RCC_R2C_STREAM is enabled (default on)
        try {
          const _flag = process.env.RCC_R2C_STREAM;
          const useBridge = (_flag === undefined) || _flag === '1' || (_flag?.toLowerCase?.() === 'true');
          const topReadable = response && typeof (response as any).pipe === 'function' ? (response as any) : null;
          const nestedReadable = (!topReadable && response && typeof (response as any).data?.pipe === 'function') ? (response as any).data : null;
          const readable = topReadable || nestedReadable;
          if (useBridge && readable) {
            const core = await import('rcc-llmswitch-core/conversion');
            const windowMs = Number(process.env.RCC_R2C_COALESCE_MS || 1000) || 1000;
            await (core as any).transformOpenAIStreamToResponses(readable, res, { requestId, model: req.body.model, windowMs, tools: (req.body as any)?.tools });
            return;
          }
        } catch { /* fall through to synthetic SSE */ }

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

      // Return JSON response in OpenAI Responses format（确定性路径，无流时只返回 JSON）
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
      // If client requested SSE, emit SSE error and close the stream instead of JSON
      try {
        const accept = String(req.headers['accept'] || '').toLowerCase();
        const wantsSSE = (accept.includes('text/event-stream') || req.body?.stream === true);
        if (wantsSSE && !res.writableEnded) {
          try {
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('x-request-id', requestId);
            }
            const errMsg = (error instanceof Error ? error.message : String(error)) || 'stream error';
            const evt = { type: 'response.error', error: { message: errMsg, type: 'streaming_error', code: 'STREAM_FAILED' }, requestId } as Record<string, unknown>;
            res.write(`event: response.error\n`);
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
          return;
        }
      } catch { /* ignore */ }

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
    } as any;

    // Inject route.requestId into payload metadata for downstream providers (capture + pairing)
    try {
      const dataObj = pipelineRequest.data as Record<string, unknown>;
      const meta = (dataObj as any)._metadata && typeof (dataObj as any)._metadata === 'object'
        ? { ...(dataObj as any)._metadata }
        : {};
      (dataObj as any)._metadata = { ...meta, requestId };
    } catch { /* ignore */ }

    // Debug: capture final request payload before entering pipeline (to diagnose client tolerance issues)
    try {
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'openai-responses');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `${requestId}_pre-pipeline.json`);
      await (fs as any).writeFile(file, JSON.stringify({ requestId, payload: pipelineRequest.data }, null, 2), 'utf-8');
    } catch { /* ignore */ }

    const pipelineTimeoutMs = Number(
      process.env.ROUTECODEX_TIMEOUT_MS ||
      process.env.RCC_TIMEOUT_MS ||
      process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS ||
      300000
    );
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
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'openai-responses');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `${requestId}_provider-response.json`);
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
    const streamAborted = false;
    // audit writer stub (initialized after fs paths are ready)
    let auditWrite: (kind: 'event' | 'meta' | 'end' | 'error', payload: Record<string, unknown>) => Promise<void> = async () => Promise.resolve();
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const baseDir = path.join(home || '', '.routecodex', 'codex-samples');
      const subDir = path.join(baseDir, 'openai-responses');
      const sseFile = path.join(subDir, `${requestId}_sse-events.log`);
      const sseAuditFile = path.join(subDir, `${requestId}_sse-audit.log`);
      const ensureDirs = async () => { try { await fs.mkdir(subDir, { recursive: true }); } catch { /* ignore */ } };
      const capture = async (event: string, data: unknown) => {
        try {
          await ensureDirs();
          const line = `${JSON.stringify({ ts: Date.now(), requestId, event, data })  }\n`;
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
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      try { res.setHeader('X-Accel-Buffering', 'no'); } catch { /* ignore */ }
      res.setHeader('x-request-id', requestId);
      try { (res as any).flushHeaders?.(); } catch { /* ignore */ }
      await auditWrite('meta', { phase: 'headers', headers: {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'x-request-id': requestId
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
      // Normalize tools declaration for Responses SSE metadata (align with other routes)
      try {
        const rawTools = (requestMeta as any).tools;
        if (Array.isArray(rawTools)) {
          const nt = normalizeTools(rawTools as any[]);
          (requestMeta as any).tools = (nt as any[]).map((t: any) => (t && t.type === 'function' && t.function && typeof t.function === 'object') ? { ...t, function: { ...t.function, strict: true } } : t);
        }
      } catch { /* ignore tools normalize errors */ }
      const requestInstructions = typeof reqInstructions === 'string' ? reqInstructions : undefined;
      if (requestInstructions && !requestMeta.instructions) {
        requestMeta.instructions = requestInstructions;
      }
      if (reqTools !== undefined && requestMeta.tools === undefined) {requestMeta.tools = reqTools;}
      if (reqToolChoice !== undefined && requestMeta.tool_choice === undefined) {requestMeta.tool_choice = reqToolChoice;}
      if (reqParallel !== undefined && requestMeta.parallel_tool_calls === undefined) {requestMeta.parallel_tool_calls = reqParallel;}
      // If tool-followup is present, prefer __initial for tool events and __final for text/usage
      const rawInitial = (response && typeof response === 'object' && (response as any).__initial) ? (response as any).__initial : response;
      const rawFinal = (response && typeof response === 'object' && (response as any).__final) ? (response as any).__final : response;

      // Normalize both initial/final payloads into OpenAI Responses JSON (passthrough if already Responses)
      const toResponsesShape = async (payload: any) => {
        // Always use core bridge to ensure canonical sanitation (e.g., strip tool result envelopes)
        return buildResponsesPayloadFromChat(payload, undefined) as Record<string, unknown>;
      };
      const initialResp = await toResponsesShape(rawInitial);
      const finalResp = await toResponsesShape(rawFinal);

      try {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'openai-responses');
      await (fs as any).mkdir(dir, { recursive: true });
      await (fs as any).writeFile(path.join(dir, `${requestId}_responses-initial.json`), JSON.stringify(initialResp, null, 2), 'utf-8');
      await (fs as any).writeFile(path.join(dir, `${requestId}_responses-final.json`), JSON.stringify(finalResp, null, 2), 'utf-8');
      } catch { /* ignore */ }

      const extractText = (resp: any): string => {
        const texts: string[] = [];
        const push = (s?: string) => { if (typeof s === 'string') { const t = s.trim(); if (t) {texts.push(t);} } };
        const walkBlocks = (blocks: any[]): void => {
          for (const b of blocks || []) {
            if (!b || typeof b !== 'object') {continue;}
            const t = (b as any).type;
            if ((t === 'text' || t === 'output_text') && typeof (b as any).text === 'string') { push((b as any).text); continue; }
            if (t === 'message' && Array.isArray((b as any).content)) { walkBlocks((b as any).content); continue; }
            if (Array.isArray((b as any).content)) { walkBlocks((b as any).content); }
          }
        };
        try {
          if (resp && typeof resp.output_text === 'string') {push(resp.output_text);}
          if (resp && Array.isArray(resp.output)) {walkBlocks(resp.output);}
          if (resp && Array.isArray(resp.content)) {walkBlocks(resp.content);}
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
          if (obj[key] === undefined) {delete obj[key];}
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
        if (!('background' in snap)) {snap.background = false;}
        if (!('error' in snap)) {snap.error = null;}
        if (!('incomplete_details' in snap)) {snap.incomplete_details = null;}
        if (requestMeta.instructions && !snap.instructions) {snap.instructions = requestMeta.instructions;}
        if (requestMeta.reasoning && !snap.reasoning) {snap.reasoning = requestMeta.reasoning;}
        if (requestMeta.tool_choice && !snap.tool_choice) {snap.tool_choice = requestMeta.tool_choice;}
        if (requestMeta.parallel_tool_calls !== undefined && !snap.parallel_tool_calls) {snap.parallel_tool_calls = requestMeta.parallel_tool_calls;}
        if (requestMeta.tools && !snap.tools) {snap.tools = requestMeta.tools;}
        if (requestMeta.store !== undefined && !snap.store) {snap.store = requestMeta.store;}
        if (requestMeta.include && !snap.include) {snap.include = requestMeta.include;}
        if (requestMeta.prompt_cache_key && !snap.prompt_cache_key) {snap.prompt_cache_key = requestMeta.prompt_cache_key;}
        // Prefer provider-reported model; only fallback to request model when missing
        snap.model = (snap.model as string) || (model as string) || 'unknown';
        if (!snap.metadata) {snap.metadata = {};}
        if (!Array.isArray(snap.output) && Array.isArray(finalResp?.output)) {snap.output = finalResp?.output;}
        if (!('output_text' in snap)) {snap.output_text = finalResp?.output_text ?? textOut ?? '';}
        if (finalResp?.usage && !snap.usage) {snap.usage = finalResp.usage;}
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
        // Avoid sending giant instructions block in early SSE events to prevent client buffering/stalls
        if (typeof (snap as any).instructions === 'string') {
          delete (snap as any).instructions;
        }
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
        if (!Array.isArray(funcCalls) || funcCalls.length === 0) {return null;}
        const toStringArgs = (v: any): string => {
          if (typeof v === 'string') {return v;}
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
      // 主动“按优先级”提取工具调用：
      // 1) final.output 中的 function_call/tool_call
      // 2) initial.output 中的 function_call/tool_call
      // 3) final.required_action.submit_tool_outputs.tool_calls
      // 4) initial.required_action.submit_tool_outputs.tool_calls
      const getFuncCallsFromRequiredAction = (resp: any): any[] => {
        try {
          const ra = resp?.required_action;
          const arr = (ra && ra.type === 'submit_tool_outputs') ? (ra.submit_tool_outputs?.tool_calls || []) : [];
          if (!Array.isArray(arr) || !arr.length) {return [];}
          return arr.map((c: any) => ({
            type: 'function_call',
            id: c?.id,
            call_id: c?.id || c?.call_id,
            name: c?.name || c?.function?.name,
            arguments: c?.arguments || c?.function?.arguments || '{}',
            status: 'in_progress'
          }));
        } catch { return []; }
      };
      const pickFuncCalls = (): any[] => {
        const f1 = getFunctionCalls(finalResp); if (Array.isArray(f1) && f1.length) {return f1;}
        const f2 = getFunctionCalls(initialResp); if (Array.isArray(f2) && f2.length) {return f2;}
        const f3 = getFuncCallsFromRequiredAction(finalResp); if (Array.isArray(f3) && f3.length) {return f3;}
        const f4 = getFuncCallsFromRequiredAction(initialResp); if (Array.isArray(f4) && f4.length) {return f4;}
        return [];
      };
      let funcCalls = pickFuncCalls();
      // 过滤无效函数调用（缺少 name 或 name 为 'tool'），避免发出不可执行的 function_call 事件
      funcCalls = Array.isArray(funcCalls) ? funcCalls.filter((it: any) => {
        const nm = (typeof it?.name === 'string' ? it.name : (typeof it?.function?.name === 'string' ? it.function.name : '')).trim();
        return nm.length > 0 && nm.toLowerCase() !== 'tool';
      }) : [];

      // Build known MCP servers (env + discovered from original request snapshot)
      const knownServers = (() => {
        const set = new Set<string>();
        try {
          const serversRaw = String(process.env.ROUTECODEX_MCP_SERVERS || '').trim();
          if (serversRaw) { for (const s of serversRaw.split(',').map(x => x.trim()).filter(Boolean)) {set.add(s);} }
          const snap = (reqMeta && typeof reqMeta === 'object') ? reqMeta : {};
          const messages = Array.isArray((snap as any).messages) ? ((snap as any).messages as any[]) : [];
          for (const m of messages) {
            try {
              if (m && m.role === 'tool' && typeof m.content === 'string') {
                const o = JSON.parse(m.content); const sv = o?.arguments?.server; if (typeof sv === 'string' && sv.trim()) {set.add(sv.trim());}
              }
              if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                  const argStr = String(tc?.function?.arguments ?? '');
                  try { const parsed = JSON.parse(argStr); const sv = parsed?.server; if (typeof sv === 'string' && sv.trim()) {set.add(sv.trim());} } catch {}
                }
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        return set;
      })();
      if (Array.isArray(funcCalls) && funcCalls.length > 0) {
        // Stream function_call lifecycle and arguments deltas
        const toArgsStr = (v: any) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } })());
        const canonicalizeTool = (name: string | undefined, argsStr: string): { name: string; args: string } => {
          const whitelist = new Set(['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);
          if (!name || typeof name !== 'string') {return { name: 'tool', args: argsStr };}
          const dot = name.indexOf('.');
          if (dot <= 0) {return { name, args: argsStr };}
          const base = name.slice(dot + 1).trim();
          if (!whitelist.has(base)) {return { name, args: argsStr };}
          // Drop the dotted prefix unconditionally; do not inject server from prefix
          return { name: base, args: argsStr };
        };
        // Reserve 0 for text outputs; tool_call items start at 1
        let outIndex = 1;
        // Deduplicate short-window identical function_call (name + arguments)
        const WINDOW = Math.max(1, Math.min(16, Number(process.env.ROUTECODEX_TOOL_CALL_DEDUPE_WINDOW || 4)));
        const lastKeys: string[] = [];
        const lastSet = new Set<string>();
        for (const it of funcCalls) {
          const id = typeof it.id === 'string' ? it.id : (typeof it.call_id === 'string' ? it.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
          const call_id = typeof it.call_id === 'string' ? it.call_id : id;
          const rawName = typeof it.name === 'string' ? it.name : (typeof it.tool_name === 'string' ? it.tool_name : (it?.function?.name || 'tool'));
          const rawArgs = toArgsStr(it.arguments ?? it?.function?.arguments ?? {});
          const { name, args: argsStr } = canonicalizeTool(rawName, rawArgs);
          const currKey = `${String(name || '')}\n${String(argsStr || '')}`;
          if (lastSet.has(currKey)) { continue; }
          lastSet.add(currKey);
          lastKeys.push(currKey);
          if (lastKeys.length > WINDOW) {
            const old = lastKeys.shift();
            if (old) {lastSet.delete(old);}
          }
          // Align item.type with stable schema
          await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: outIndex, item: { id, type: 'tool_call', status: 'in_progress', arguments: '', call_id, name } });
          // Early required_action (idempotent per call id)
          try {
            const responseMeta = { id: (baseResp as any)?.id || `resp_${requestId}`, object: 'response', created_at: createdTs, model: (baseResp as any)?.model || (model || 'unknown') } as Record<string, unknown>;
            const tool_calls_submit = [ { id, type: 'function', function: { name: String(name), arguments: '' } } ];
            const tool_calls_simple = [ { id, type: 'function', name: String(name) } ];
            await writeEvt('response.required_action', { type: 'response.required_action', response: responseMeta, required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: tool_calls_submit } } });
            // compatibility variant for clients expecting type='tool_calls' (top-level name)
            await writeEvt('response.required_action', { type: 'response.required_action', response: responseMeta, required_action: { type: 'tool_calls', tool_calls: tool_calls_simple } });
          } catch { /* ignore early RA */ }
          await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: id, output_index: outIndex, content_index: 0, part: { type: 'input_json', partial_json: '' } });
          // arguments deltas
          const parts = Math.max(3, Math.min(12, Math.ceil(argsStr.length / 8)));
          const step = Math.max(1, Math.ceil(argsStr.length / parts));
          for (let i = 0; i < argsStr.length; i += step) {
            const d = argsStr.slice(i, i + step);
            await writeEvt('response.tool_call.delta', { type: 'response.tool_call.delta', item_id: id, output_index: outIndex, delta: { arguments: d } });
            await writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: id, output_index: outIndex, delta: d });
          }
          await writeEvt('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: id, output_index: outIndex, arguments: String(argsStr) });
          await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: outIndex, item: { id, type: 'tool_call', status: 'completed', arguments: String(argsStr), call_id, name } });
          outIndex += 1;
        }
        // After function_call streaming, emit required_action for clients to submit tool outputs
        try {
          const ra = deriveRequiredAction(funcCalls);
          if (ra) {
            const responseMeta = { id: (baseResp as any)?.id || `resp_${requestId}`, object: 'response', created_at: createdTs, model: (baseResp as any)?.model || (model || 'unknown') } as Record<string, unknown>;
            await writeEvt('response.required_action', { type: 'response.required_action', response: responseMeta, required_action: ra });
            // compatibility: emit tool_calls variant as well (top-level name)
            if ((ra as any)?.type === 'submit_tool_outputs') {
              const calls = (ra as any)?.submit_tool_outputs?.tool_calls || [];
              const tool_calls_simple = calls.map((c: any) => ({ id: (c?.id || c?.call_id), type: 'function', name: (c?.function?.name || c?.name) }));
              await writeEvt('response.required_action', { type: 'response.required_action', response: responseMeta, required_action: { type: 'tool_calls', tool_calls: tool_calls_simple } });
            }
          }
        } catch { /* ignore */ }

        // After function_call streaming, emit completed and close
        const srcUsage2 = finalResp?.usage ? finalResp.usage : (initialResp?.usage ? initialResp.usage : undefined);
        const usage2 = (() => {
          if (!srcUsage2 || typeof srcUsage2 !== 'object') {return undefined as unknown as Record<string, number> | undefined;}
          const input = (typeof (srcUsage2 as any).input_tokens === 'number') ? (srcUsage2 as any).input_tokens : (typeof (srcUsage2 as any).prompt_tokens === 'number' ? (srcUsage2 as any).prompt_tokens : 0);
          const output = (typeof (srcUsage2 as any).output_tokens === 'number') ? (srcUsage2 as any).output_tokens : (typeof (srcUsage2 as any).completion_tokens === 'number' ? (srcUsage2 as any).completion_tokens : 0);
          const total = (typeof (srcUsage2 as any).total_tokens === 'number') ? (srcUsage2 as any).total_tokens : (input + output);
          return { input_tokens: input, output_tokens: output, total_tokens: total } as Record<string, number>;
        })();
        const completedSnapshot2 = { ...baseResp, status: 'completed' } as Record<string, unknown>;
        completedSnapshot2.created_at = completedSnapshot2.created_at ?? createdTs;
        if (usage2) {completedSnapshot2.usage = usage2;}
        const completed2 = { type: 'response.completed', response: toCleanObject(completedSnapshot2) } as Record<string, unknown>;
        await writeEvt('response.completed', completed2);
        // Emit terminal done event to signal clients to stop reconnecting
        await writeEvt('response.done', { type: 'response.done' } as unknown as Record<string, unknown>);
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
        if (!u || typeof u !== 'object') {return undefined as unknown;}
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
      if (usage) {completedSnapshot.usage = usage;}
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
      await writeEvt('response.done', { type: 'response.done' } as unknown as Record<string, unknown>);
      // Compatibility: some clients expect a final [DONE] line
      try { res.write(`data: [DONE]\n\n`); } catch { /* ignore */ }
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
      // Ensure clients always receive a terminal event
      try {
        const doneEvt = { type: 'response.done' } as Record<string, unknown>;
        res.write(`event: response.done\n`);
        res.write(`data: ${JSON.stringify(doneEvt)}\n\n`);
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
              try {
                const nt = Array.isArray((reqMeta as any).tools) ? normalizeTools((reqMeta as any).tools as any[]) : (reqMeta as any).tools;
                const toolsStrict = Array.isArray(nt) ? (nt as any[]).map((t: any) => (t && t.type === 'function' && t.function && typeof t.function === 'object') ? { ...t, function: { ...t.function, strict: true } } : t) : nt;
                meta.tools = toolsStrict;
              } catch {
                meta.tools = reqMeta.tools as unknown as any[];
              }
              try {
                const crypto = await import('crypto');
                const str = JSON.stringify(meta.tools);
                const hash = crypto.createHash('sha256').update(str).digest('hex');
                (meta as any).tools_hash = hash;
                if (Array.isArray(meta.tools)) {(meta as any).tools_count = (meta.tools as any[]).length;}
              } catch { /* ignore */ }
            }
            if (typeof reqMeta.tool_choice !== 'undefined') {meta.tool_choice = reqMeta.tool_choice;}
            if (typeof reqMeta.parallel_tool_calls !== 'undefined') {meta.parallel_tool_calls = reqMeta.parallel_tool_calls;}
            base.metadata = meta;
            return await ResponsesMapper.enrichResponsePayload(base, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
          }
          return await ResponsesMapper.enrichResponsePayload(payload as Record<string, unknown>, payload as Record<string, unknown>, reqMeta as Record<string, unknown>);
        }
      }
    } catch { /* ignore */ }
    try {
      // Core codec: Chat JSON → Responses JSON（严格、按 schema 归一），并传入请求工具上下文以统一出参行为
      let toolsNorm: Array<Record<string, unknown>> = [];
      const reqTools = reqMeta?.tools as unknown;
      if (Array.isArray(reqTools)) {
        try { toolsNorm = normalizeTools(reqTools as any[]); } catch { /* ignore */ }
      }
      const ctx = {
        metadata: toolsNorm.length ? { tools: toolsNorm } : undefined,
        toolsRaw: Array.isArray(reqTools) ? (reqTools as any[]) : undefined,
        toolsNormalized: toolsNorm,
        toolChoice: (reqMeta as any)?.tool_choice,
        parallelToolCalls: (reqMeta as any)?.parallel_tool_calls,
      } as any;
      const converted0 = buildResponsesPayloadFromChat(payload, ctx) as Record<string, unknown>;

      // Synthesize required_action for non-stream JSON when存在 function_call 输出
      const outputs = Array.isArray((converted0 as any)?.output) ? ((converted0 as any).output as any[]) : [];
      const funcCalls = outputs.filter(it => it && (it.type === 'function_call' || it.type === 'tool_call'));
      let converted = converted0;
      if (funcCalls.length > 0) {
        const toStringJson = (v: unknown): string => {
          if (typeof v === 'string') {return v;}
          try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
        };
        const calls = funcCalls.map((it: any) => {
          const id = typeof it.id === 'string' ? it.id : (typeof it.call_id === 'string' ? it.call_id : `call_${Math.random().toString(36).slice(2,8)}`);
          const nm = typeof it.name === 'string' ? it.name : (typeof it?.function?.name === 'string' ? it.function.name : 'tool');
          const rawArgs = it.arguments ?? it?.function?.arguments ?? {};
          const argsStr = toStringJson(rawArgs);
          return { id, type: 'function', function: { name: String(nm), arguments: String(argsStr) } };
        });
        // Validation warnings for unsafe write redirection (cat > without heredoc)
        const warnings: Array<Record<string, unknown>> = [];
        const detectWriteRedirection = (name: string | undefined, args: string): boolean => {
          try {
            if (!name || name.toLowerCase() !== 'shell') {return false;}
            const obj = JSON.parse(args);
            const cmd = obj?.command;
            const getScript = (): string => {
              if (typeof cmd === 'string') {return cmd;}
              if (Array.isArray(cmd)) {return cmd.map((x: any) => String(x)).join(' ');}
              return '';
            };
            const s = getScript().toLowerCase();
            if (!s) {return false;}
            const hasBash = /\bbash\b\s+-lc\b/.test(s);
            const hasCatWrite = /cat\s*>\s*[^\s<]+/.test(s);
            const hasHeredoc = /<</.test(s);
            return hasBash && hasCatWrite && !hasHeredoc;
          } catch { return false; }
        };
        for (const c of calls) {
          try {
            const nm = (c as any)?.function?.name as string | undefined;
            const argStr = (c as any)?.function?.arguments as string || '{}';
            if (detectWriteRedirection(nm, argStr)) {
              warnings.push({
                call_id: (c as any)?.id,
                name: nm || 'tool',
                kind: 'write_redirection_without_heredoc',
                message: '禁止使用 cat 重定向写文件，请改用 apply_patch。',
                suggestion: '使用统一 diff 补丁：\n*** Begin Patch\n*** Update File: path/to/file\n@@\n- old line\n+ new line\n*** End Patch'
              });
            }
          } catch { /* ignore */ }
        }
        const required_action: any = { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: calls } };
        if (warnings.length) {(required_action as any).validation = { warnings };}
        converted = { ...(converted0 as any), required_action };
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
