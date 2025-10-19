/**
 * Responses Handler Implementation
 * Handles Anthropic-compatible responses requests
 */

import express, { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ResponseNormalizer } from '../utils/response-normalizer.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { ProtocolDetector } from '../protocol/protocol-detector.js';
import { AnthropicAdapter } from '../protocol/anthropic-adapter.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Responses Handler
 * Handles /v1/messages endpoint (Anthropic responses)
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
    const startTime = Date.now();
    const requestId = this.generateRequestId();

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
      // Forced adapter preflight: convert OpenAI-shaped payloads to Anthropic Responses format
      try {
        const looksOpenAI = Array.isArray(req.body?.messages) && (req.body.messages as any[]).some((m: any) => typeof m?.content === 'string');
        const detector = new ProtocolDetector();
        const det = detector.detectFromRequest(req);
        if (looksOpenAI || det.protocol === 'openai') {
          const adapter = new AnthropicAdapter();
          req.body = adapter.convertFromProtocol(req.body, 'openai') as any;
          try { res.setHeader('x-rc-adapter', 'openai->anthropic'); } catch { /* ignore */ }
        }
      } catch { /* non-blocking */ }

      // Normalize pure Responses-shaped payload (no messages[] but has input/instructions)
      try {
        const b: any = req.body || {};
        const hasMessages = Array.isArray(b.messages);
        const hasResponsesShape = !hasMessages && (typeof b.input !== 'undefined' || typeof b.instructions !== 'undefined');
        if (hasResponsesShape) {
          const input = b.input;
          const contentBlocks = Array.isArray(input)
            ? input
            : (typeof input === 'string' && input.trim().length > 0
                ? [{ type: 'text', text: String(input) }]
                : []);
          const sys = b.instructions;
          const messages = [] as any[];
          if (typeof sys === 'string' && sys.trim()) {
            messages.push({ role: 'system', content: sys });
          }
          messages.push({ role: 'user', content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }] });
          req.body = { ...b, messages } as any;
          try { res.setHeader('x-rc-adapter', 'responses->messages'); } catch { /* ignore */ }
        }
      } catch { /* non-blocking */ }

      // Validate request (relaxed fallback for extended Responses content types)
      const validation = this.requestValidator.validateAnthropicResponse(req.body);
      if (!validation.isValid) {
        const errors = validation.errors || [];
        const allowed = [
          /invalid role:\s*system/i,
          /invalid type:\s*message/i,
          /invalid type:\s*reasoning/i,
          /invalid type:\s*function_call/i,
          /invalid type:\s*function_call_output/i,
        ];
        const lenient = errors.length > 0 && errors.every(e => allowed.some(p => p.test(String(e))));
        if (!lenient) {
          throw new RouteCodexError(
            `Request validation failed: ${validation.errors.join(', ')}`,
            'validation_error',
            400
          );
        }
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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResponsesToChatLLMSwitch } = require('../../modules/pipeline/modules/llmswitch/llmswitch-response-chat.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger };
      const conv = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
      if (typeof conv.initialize === 'function') { await conv.initialize(); }
      const rebuilt = await conv.transformRequest({ ...(req.body as any) });
      if (rebuilt && typeof rebuilt === 'object') {
        const keep: any = {};
        if (typeof (req.body as any)?.tools !== 'undefined') keep.tools = (req.body as any).tools;
        if (typeof (req.body as any)?.tool_choice !== 'undefined') keep.tool_choice = (req.body as any).tool_choice;
        if (typeof (req.body as any)?.parallel_tool_calls !== 'undefined') keep.parallel_tool_calls = (req.body as any).parallel_tool_calls;
        normalizedData = { ...(rebuilt as any), ...(modelId ? { model: modelId } : {}), ...keep };
      }
    } catch { /* ignore */ }

    // Last-resort normalizer: if仍然存在嵌套Responses历史或消息为空，直接从原始req.body.messages提取纯文本user消息
    try {
      const hasNested = Array.isArray((normalizedData as any)?.messages) && (normalizedData as any).messages.some((m: any) => Array.isArray(m?.content) && (m.content as any[]).some((b: any) => b && typeof b === 'object' && b.type === 'message'));
      const missingMsgs = !Array.isArray((normalizedData as any)?.messages) || (normalizedData as any).messages.length === 0;
      if (hasNested || missingMsgs) {
        const srcMsgs: any[] = Array.isArray((req.body as any)?.messages) ? (req.body as any).messages : [];
        const flatten = (parts: any[]): string[] => {
          const texts: string[] = [];
          for (const p of parts) {
            if (!p || typeof p !== 'object') continue;
            const kind = typeof p.type === 'string' ? String(p.type).toLowerCase() : '';
            if ((kind === 'text' || kind === 'input_text' || kind === 'output_text') && typeof (p as any).text === 'string') {
              const t = ((p as any).text as string).trim(); if (t) texts.push(t);
              continue;
            }
            if (kind === 'message' && Array.isArray((p as any).content)) {
              texts.push(...flatten((p as any).content));
              continue;
            }
            if (typeof (p as any).content === 'string') {
              const t = ((p as any).content as string).trim(); if (t) texts.push(t);
            }
          }
          return texts;
        };
        const out: any[] = [];
        for (const m of srcMsgs) {
          if (!m || typeof m !== 'object') continue;
          if (m.role === 'system' && typeof m.content === 'string' && m.content.trim()) {
            out.push({ role: 'system', content: m.content });
            continue;
          }
          if (Array.isArray(m.content)) {
            const text = flatten(m.content).join('\n');
            if (text) { out.push({ role: 'user', content: text }); }
          } else if (typeof m.content === 'string' && m.content.trim()) {
            out.push({ role: m.role || 'user', content: m.content });
          }
        }
        if (out.length) {
          (normalizedData as any).messages = out;
        }
      }
    } catch { /* ignore */ }
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
        // Let pipeline know this originated from Responses endpoint; llmswitch-response-chat will adapt
        targetProtocol: 'responses',
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
      const startHeartbeat = () => {
        const raw = process.env.ROUTECODEX_RESPONSES_HEARTBEAT_MS;
        const intervalMs = raw ? Number(raw) : 5000;
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
      startHeartbeat();

      // Minimal writer (OpenAI Responses standard; no Azure sequence/parts)
      const writeEvt = async (event: string, data: Record<string, unknown>) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        try { await capture(event, data); } catch { /* ignore */ }
      };

      // If tool-followup is present, prefer __initial for tool events and __final for text/usage
      const initialResp = (response && typeof response === 'object' && response.__initial) ? (response as any).__initial : response;
      const finalResp = (response && typeof response === 'object' && response.__final) ? (response as any).__final : response;

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
          const chat = resp?.choices?.[0]?.message?.content; if (typeof chat === 'string') push(chat);
        } catch { /* ignore */ }
        return texts.join(' ');
      };

      // Use final response text if available; fallback to initial
      const textOut = extractText(finalResp) || extractText(initialResp);
      const words = (textOut || '').split(/\s+/g).filter(Boolean);

      const baseResp = { id: `resp_${requestId}`, model: model || 'unknown' } as Record<string, unknown>;
      const now = () => Math.floor(Date.now() / 1000);
      // Text strict Azure mode removed per rollback request; keep default text path

      // response.created / in_progress (minimal OpenAI Responses)
      await writeEvt('response.created', { type: 'response.created', response: { id: baseResp.id, model: baseResp.model } });
      await writeEvt('response.in_progress', { type: 'response.in_progress', response: { id: baseResp.id, model: baseResp.model } });

      // Emit tool_call events when present in pipeline response (prefer initial turn)
      try {
        // Remove Azure output_item/content_part & function_call_arguments streaming

        const emitToolCallsFromResponsesOutput = async (_resp: any) => { /* no-op */ };
        const emitToolCallsFromOpenAI = async (_resp: any) => { /* no-op */ };

        const emitToolCallsFromAnthropic = async (_resp: any) => { /* no-op */ };

        // Prefer OpenAI-shaped tool_calls; else infer from Anthropic blocks
        const toolSource = (response && typeof response === 'object' && (response as any).__initial)
          ? (response as any).__initial
          : response;
        if (toolSource && typeof toolSource === 'object') {
          if (toolSource?.output) { await emitToolCallsFromResponsesOutput(toolSource); }
          else if (toolSource?.choices?.[0]?.message?.tool_calls) { await emitToolCallsFromOpenAI(toolSource); }
          else { await emitToolCallsFromAnthropic(toolSource); }
        }
        // Emit required_action for clients that expect submit_tool_outputs flow
        try {
          const toolCallsList: Array<{ id: string; name: string; arguments: string }> = [];
          if (Array.isArray(toolSource?.choices?.[0]?.message?.tool_calls)) {
            for (const tc of (toolSource as any).choices[0].message.tool_calls) {
              const id = tc?.id || `call_${Math.random().toString(36).slice(2)}`;
              const name = tc?.function?.name || 'tool';
              const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments || {});
              toolCallsList.push({ id, name, arguments: String(args) });
            }
          } else if (Array.isArray((toolSource as any)?.output)) {
            for (const it of (toolSource as any).output) {
              if (it && typeof it === 'object' && it.type === 'tool_call') {
                const id = it?.id || `call_${Math.random().toString(36).slice(2)}`;
                const name = it?.tool_name || it?.name || 'tool';
                const argsVal = it?.arguments ?? {};
                const args = typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal);
                toolCallsList.push({ id, name, arguments: String(args) });
              }
            }
          } else if (Array.isArray((toolSource as any)?.content)) {
            for (const b of (toolSource as any).content) {
              if (b && typeof b === 'object' && b.type === 'tool_use') {
                const id = b?.id || `call_${Math.random().toString(36).slice(2)}`;
                const name = b?.name || 'tool';
                const argsVal = b?.input ?? {};
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
      // Assistant text deltas (no output_item/content_part)
      const hadToolFirstTurn = (initialResp?.choices?.[0]?.message?.tool_calls?.length || 0) > 0
        || (Array.isArray(initialResp?.output) && initialResp.output.some((x: any) => x?.type === 'tool_call'))
        || (Array.isArray(initialResp?.content) && initialResp.content.some((x: any) => x?.type === 'tool_use'));
      if (words.length > 0 || !hadToolFirstTurn) {
        for (const w of words) {
          await writeEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: w + ' ', response: baseResp });
          await new Promise(r => setTimeout(r, 20));
        }
        await writeEvt('response.output_text.done', { type: 'response.output_text.done', response: baseResp });
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
      const completed = { type: 'response.completed', response: { ...baseResp, created_at: now(), status: 'completed', output_text: textOut || '' }, ...(usage ? { usage } : {}) } as Record<string, unknown>;
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
