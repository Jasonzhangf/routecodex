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
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'anth-replay');
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
          (req.body as any)?.instructions
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
    // Use pipeline manager if available
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }

    // Fallback implementation
    return this.createSimulatedResponse(req);
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

    const respConfig = await ResponsesConfigUtil.load();
    let normalizedData: any = { ...(req.body as any || {}), ...(modelId ? { model: modelId } : {}) };

    // Hard normalize OpenAI chat payload to GLM-safe format: ensure messages[].content is string
    try {
      if (Array.isArray(normalizedData?.messages)) {
        const anthropicBlocks = (normalizedData.messages as any[]).some((m: any) => Array.isArray(m?.content));
        if (anthropicBlocks) {
          // Keep Anthropic blocks intact for Responses routing; downstream llmswitch will handle conversion
          // Also drop any Responses-specific top-level fields if present
          delete normalizedData.input;
          delete normalizedData.instructions;
          delete normalizedData.response_format;
        } else {
        const stringify = (v: unknown): string => {
          if (v == null) return '';
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v); } catch { return String(v); }
        };
        const blocksToText = (arr: any[]): string => {
          const parts: string[] = [];
          for (const b of arr) {
            if (!b || typeof b !== 'object') { continue; }
            if (typeof b.text === 'string') { parts.push(b.text); continue; }
            if (typeof b.output === 'string') { parts.push(b.output); continue; }
            if (typeof b.name === 'string' && (b.arguments || b.args)) {
              parts.push(`Function ${b.name}(${typeof b.arguments==='string'?b.arguments:stringify(b.arguments||b.args)})`);
              continue;
            }
            // Fallback: serialize whole block
            parts.push(stringify(b));
          }
          return parts.join('\n');
        };
        normalizedData.messages = (normalizedData.messages as any[]).map((m: any) => {
          const out = { ...m };
          if (Array.isArray(out.content)) {
            out.content = blocksToText(out.content);
          } else if (typeof out.content !== 'string') {
            out.content = stringify(out.content);
          }
          // tool role must have string content
          if (out.role === 'tool' && typeof out.content !== 'string') {
            out.content = stringify(out.content);
          }
          // ensure assistant.tool_calls.function.arguments is string
          if (out.role === 'assistant' && Array.isArray(out.tool_calls)) {
            out.tool_calls = out.tool_calls.map((tc: any) => {
              if (tc && tc.function && typeof tc.function === 'object' && typeof tc.function.arguments !== 'string') {
                try { tc.function.arguments = JSON.stringify(tc.function.arguments); } catch { tc.function.arguments = String(tc.function.arguments); }
              }
              return tc;
            });
          }
          return out;
        });
        // Remove Responses-specific fields that may upset providers
        delete normalizedData.input;
        delete normalizedData.instructions;
        delete normalizedData.response_format;
        }
      }
    } catch { /* ignore */ }

    // Always synthesize a clean Chat request from Responses payload to tolerate arbitrary client shapes
    try {
      // Strictly use mapping (no llmswitch, no fallback)
      const rebuilt = await ResponsesMapper.toChatRequestFromMapping({ ...(req.body as any) }, req as any, modelId);
      normalizedData = { ...(rebuilt as any) };
    } catch (err) {
      const e = err as any;
      const rc = new RouteCodexError(e?.message || 'Invalid request', 'validation_error', typeof e?.status === 'number' ? e.status : 400);
      throw rc;
    }

    // Strict mapping only; no fallback or re-synthesis here

    const pipelineRequest = {
      data: normalizedData,
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
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'anth-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `pre-pipeline_${requestId}.json`);
      await (fs as any).writeFile(file, JSON.stringify({ requestId, normalizedData }, null, 2), 'utf-8');
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
      const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'anth-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const file = path.join(dir, `provider-response_${requestId}.json`);
      await (fs as any).writeFile(file, JSON.stringify(firstResp, null, 2), 'utf-8');
    } catch { /* ignore */ }

    // Tool-followup (方案A): if enabled, execute tools server-side and run second round
    try {
      const execEnabled = (() => {
        const v = String(process.env.ROUTECODEX_TOOL_SERVER_EXEC || '').trim().toLowerCase();
        return v === '1' || v === 'true' || v === 'yes';
      })();
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
      // OpenAI Chat tool_calls
      try {
        const tcs = (firstResp as any)?.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const id = tc?.id || `call_${Math.random().toString(36).slice(2)}`;
            const name = tc?.function?.name || 'tool';
            const args = tc?.function?.arguments || '{}';
            toolCalls.push({ id, name, args });
          }
        }
      } catch { /* ignore */ }
      // Anthropic tool_use blocks
      try {
        const content = Array.isArray((firstResp as any)?.content) ? (firstResp as any).content : [];
        for (const b of content) {
          if (b && typeof b === 'object' && b.type === 'tool_use') {
            const id = b?.id || `call_${Math.random().toString(36).slice(2)}`;
            const name = b?.name || 'tool';
            const args = b?.input || {};
            toolCalls.push({ id, name, args });
          }
        }
      } catch { /* ignore */ }
      // Responses output tool_call
      try {
        const out = Array.isArray((firstResp as any)?.output) ? (firstResp as any).output : [];
        for (const it of out) {
          if (it && typeof it === 'object' && it.type === 'tool_call') {
            const id = it?.id || `call_${Math.random().toString(36).slice(2)}`;
            const name = it?.tool_name || it?.name || 'tool';
            const args = it?.arguments || {};
            toolCalls.push({ id, name, args });
          }
        }
      } catch { /* ignore */ }

      if (execEnabled && toolCalls.length > 0) {
        // Execute tools (whitelisted) and build second-turn messages
        const { executeTool } = await import('../utils/tool-executor.js');
        const results: Array<{ id: string; content: string; error?: string }> = [];
        for (const spec of toolCalls) {
          try {
            const r = await executeTool({ id: spec.id, name: spec.name, args: spec.args });
            const content = r.error ? `Tool ${r.name} error: ${r.error}` : (r.output || '(no output)');
            results.push({ id: spec.id, content, ...(r.error ? { error: r.error } : {}) });
          } catch (e: any) {
            results.push({ id: spec.id, content: `Tool ${spec.name} failed: ${e?.message || String(e)}` });
          }
        }

        // Build second request in OpenAI chat shape: append tool messages
        const secondData = {
          ...normalizedData,
          stream: false,
          messages: [
            ...((normalizedData as any)?.messages || []),
            ...results.map(r => ({ role: 'tool', content: r.content, tool_call_id: r.id }))
          ]
        };

        const secondReq = {
          data: secondData,
          route: {
            providerId,
            modelId,
            requestId,
            timestamp: Date.now(),
            pipelineId,
          },
          metadata: {
            method: 'POST',
            url: '/v1/responses',
            headers: this.sanitizeHeaders(req.headers),
            targetProtocol: 'openai',
            endpoint: '/v1/responses'
          },
          debug: { enabled: true, stages: { llmSwitch: true, workflow: true, compatibility: true, provider: true } }
        };

        const second = await Promise.race([
          this.getPipelineManager()?.processRequest?.(secondReq) || Promise.reject(new Error('Pipeline manager not available')),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
        ]);
        const secondResp = (second && typeof second === 'object' && 'data' in second) ? (second as any).data : second;
        return { __initial: firstResp, __final: secondResp, __tools: results };
      }
    } catch { /* ignore tool follow-up errors, fallback to first response */ }

    return firstResp;
  }

  /**
   * Create simulated response for fallback
   */
  private createSimulatedResponse(req: Request): any {
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'This is a simulated response from ResponsesHandler'
        }
      ],
      model: req.body.model || 'claude-3-sonnet-20240229',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    };
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
    reqInstructions?: unknown
  ): Promise<void> {
    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const baseDir = path.join(home || '', '.routecodex', 'codex-samples');
      const subDir = path.join(baseDir, 'anth-replay');
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
      await startHeartbeat();

      // Minimal writer (OpenAI Responses standard; no Azure sequence/parts)
      const writeEvt = async (event: string, data: Record<string, unknown>) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        try { await capture(event, data); } catch { /* ignore */ }
      };

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
        const dir = path.join((os as any).homedir(), '.routecodex', 'codex-samples', 'anth-replay');
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

      const baseResp = { id: `resp_${requestId}`, model: model || 'unknown' } as Record<string, unknown>;
      const now = () => Math.floor(Date.now() / 1000);
      // Text strict Azure mode removed per rollback request; keep default text path

      // response.created / in_progress (OpenAI Responses shape)
      const createdTs = now();
      await writeEvt('response.created', {
        type: 'response.created',
        response: { id: baseResp.id, object: 'response', created: createdTs, model: baseResp.model, status: 'in_progress' }
      });
      await writeEvt('response.in_progress', {
        type: 'response.in_progress',
        response: { id: baseResp.id, object: 'response', created: createdTs, model: baseResp.model, status: 'in_progress' }
      });

      // Emit tool/function_call events when present in normalized Responses output
      try {
        const emitToolCallsFromResponsesOutput = async (resp: any) => {
          const out = Array.isArray(resp?.output) ? resp.output : [];
          for (const it of out) {
            if (!it || typeof it !== 'object') continue;
            if ((it as any).type === 'tool_call' || (it as any).type === 'function_call') {
              const id = (it as any).id || `call_${Math.random().toString(36).slice(2)}`;
              const name = (it as any).tool_name || (it as any).name || 'tool';
              const argsVal = (it as any).arguments ?? (it as any)?.tool_call?.function?.arguments ?? {};
              const args = typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal);
              // output_item.added(function_call)
              await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { id, type: 'function_call', name } });
              // content_part.added(input_json)
              await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: id, output_index: 1, content_index: 0, part: { type: 'input_json', partial_json: '' } });
              // arguments delta (single chunk for now)
              await writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', id, delta: String(args) });
              await writeEvt('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', id });
              await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { id, type: 'function_call' } });
            }
          }
        };

        const toolSource = finalResp && typeof finalResp === 'object' ? finalResp : {};
        await emitToolCallsFromResponsesOutput(toolSource);
        // Emit required_action for clients that expect submit_tool_outputs flow
        try {
          const cfg = await ResponsesConfigUtil.load();
          const emitRequired = !!cfg.mappings.tools.emitRequiredAction; // mapping-driven
          if (!emitRequired) { /* skip */ return; }
          const toolCallsList: Array<{ id: string; name: string; arguments: string }> = [];
          if (Array.isArray((toolSource as any)?.output)) {
            for (const it of (toolSource as any).output) {
              if (it && typeof it === 'object' && it.type === 'tool_call') {
                const id = it?.id || `call_${Math.random().toString(36).slice(2)}`;
                const name = it?.tool_name || it?.name || 'tool';
                const argsVal = it?.arguments ?? {};
                const args = typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal);
                toolCallsList.push({ id, name, arguments: String(args) });
              }
            }
          }
          if (toolCallsList.length > 0) {
            await writeEvt('response.required_action', {
              type: 'response.required_action',
              response: { id: baseResp.id, model: baseResp.model },
              required_action: {
                type: 'submit_tool_outputs',
                submit_tool_outputs: { tool_calls: toolCallsList }
              }
            } as Record<string, unknown>);
          }
        } catch { /* ignore */ }
        // Do not emit server-side tool_result streaming; client manages tools
      } catch { /* ignore */ }
      // Assistant text deltas
      const hadToolFirstTurn = (Array.isArray((initialResp as any)?.output) && (initialResp as any).output.some((x: any) => x?.type === 'tool_call'))
        || (Array.isArray((initialResp as any)?.content) && (initialResp as any).content.some((x: any) => x?.type === 'tool_use'));
      if (words.length > 0 || !hadToolFirstTurn) {
        // Emit item lifecycle gated by config
        const cfg = await ResponsesConfigUtil.load();
        if (cfg.sse.emitTextItemLifecycle) {
          const msgId = `msg_${requestId}`;
          await writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
          await writeEvt('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
          for (const w of words) {
            await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: w + ' ' });
            await new Promise(r => setTimeout(r, 12));
          }
          await writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 0 });
          await writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: msgId, type: 'message', status: 'completed' } });
        } else {
          // Minimal text-only delta/done
          for (const w of words) {
            await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: w + ' ' });
            await new Promise(r => setTimeout(r, 12));
          }
          await writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 0 });
        }
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
      let usage = mapUsage(srcUsage) as Record<string, number> | undefined;
      if (!usage) { usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 } as any; }
      const completed = { type: 'response.completed', response: { id: baseResp.id, object: 'response', created: createdTs, model: baseResp.model, status: 'completed', output_text: textOut || '' }, ...(usage ? { usage } : {}) } as Record<string, unknown>;
      if (typeof reqInstructions === 'string' && reqInstructions.trim()) { (completed as any).instructions = reqInstructions; }
      await writeEvt('response.completed', completed);
      try { await writeEvt('response.done', { type: 'response.done' }); } catch { /* ignore */ }
      // no SSE audit summary when Azure artifacts removed
      try { res.end(); } catch { /* ignore */ }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    } catch (err) {
      try {
        const e = { type: 'response.error', error: { message: (err as Error).message || 'stream error', type: 'streaming_error', code: 'STREAM_FAILED' }, requestId } as Record<string, unknown>;
        res.write(`event: response.error\n`);
        res.write(`data: ${JSON.stringify(e)}\n\n`);
        // Always send done sentinel on error to satisfy clients expecting a terminator
        res.write(`event: response.done\n`);
        res.write(`data: {"type":"response.done"}\n\n`);
      } catch { /* ignore */ }
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
          // If executed tool results exist on wrapper, merge them into output as tool_result items
          try {
            const wrapper: any = raw || {};
            const executed = Array.isArray(wrapper.__tools) ? wrapper.__tools as Array<{ id: string; content: string; error?: string }> : [];
            if (executed.length && payload && typeof payload === 'object') {
              const base: any = { ...(payload as any) };
              base.output = Array.isArray(base.output) ? base.output.slice() : [];
              for (const r of executed) {
                base.output.push({ type: 'tool_result', id: r.id, content: r.content, is_error: !!r.error });
              }
              // Also aggregate output_text to include tool results as prefix
              try {
                const prefix = executed.map(x => `[tool_result ${x.id}]\n${x.content}`).join('\n\n');
                base.output_text = (prefix ? `${prefix}\n\n` : '') + (base.output_text || '');
              } catch { /* ignore */ }
              // Echo requested tools to client (透传)
              if (reqMeta && typeof reqMeta === 'object') {
                base.metadata = {
                  ...(base.metadata || {}),
                  ...(typeof reqMeta.tools !== 'undefined' ? { tools: reqMeta.tools } : {}),
                  ...(typeof reqMeta.tool_choice !== 'undefined' ? { tool_choice: reqMeta.tool_choice } : {}),
                  ...(typeof reqMeta.parallel_tool_calls !== 'undefined' ? { parallel_tool_calls: reqMeta.parallel_tool_calls } : {}),
                };
              }
              return base;
            }
          } catch { /* ignore */ }
          // No server-executed tool results; still echo tools if present
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
            return base;
          }
          return payload;
        }
      }
    } catch { /* ignore */ }
    try {
      // lazy import via require to avoid ESM type friction
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResponsesToChatLLMSwitch } = require('../../modules/pipeline/modules/llmswitch/llmswitch-response-chat.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
      if (typeof conv.initialize === 'function') { await conv.initialize(); }
      const converted = await conv.transformResponse(payload);
      return converted;
    } catch {
      // Fallback minimal Responses wrapper
      const model = (payload && (payload as any).model) || 'unknown';
      const id = (payload && (payload as any).id) || `resp_${Date.now()}`;
      const text = (payload && (payload as any).choices && (payload as any).choices[0] && (payload as any).choices[0].message && typeof (payload as any).choices[0].message.content === 'string')
        ? (payload as any).choices[0].message.content
        : '';
      return { id, object: 'response', created: Math.floor(Date.now()/1000), model, status: 'completed', output: [], output_text: text };
    }
  }
}
