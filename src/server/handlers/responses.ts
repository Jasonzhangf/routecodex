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
        await this.streamResponsesSSE(response, requestId, res, req.body.model);
        return;
      }

      // Return JSON response
      const normalized = this.responseNormalizer.normalizeAnthropicResponse(response);
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
    // Convert Anthropic-shaped messages to OpenAI chat payload to match GLM/OpenAI providers downstream
    try {
      const looksAnthropicBlocks = Array.isArray(normalizedData?.messages) && (normalizedData.messages as any[]).some((m: any) => Array.isArray(m?.content));
      if (looksAnthropicBlocks) {
        // lazy import from dist-level path via relative require
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { AnthropicOpenAIConverter } = require('../../modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
        const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
        const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
        const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: {} }, deps);
        if (typeof conv.initialize === 'function') { await conv.initialize(); }
        const converted = conv.convertAnthropicRequestToOpenAI(normalizedData);
        if (converted && typeof converted === 'object') {
          normalizedData = converted;
        }
      }
    } catch { /* non-blocking */ }

    // Hard normalize OpenAI chat payload to GLM-safe format: ensure messages[].content is string
    try {
      if (Array.isArray(normalizedData?.messages)) {
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

    const pipelineTimeoutMs = Number(process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS || 300000);
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);

    return pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
      ? (pipelineResponse as Record<string, unknown>).data
      : pipelineResponse;
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
  private async streamResponsesSSE(response: any, requestId: string, res: Response, model?: string): Promise<void> {
    try {
      // Headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-request-id', requestId);

      const extractText = (resp: any): string => {
        try {
          // Anthropic-style
          if (resp && Array.isArray(resp.content)) {
            const parts: string[] = [];
            for (const b of resp.content) {
              if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
            }
            return parts.join(' ');
          }
          // OpenAI-style
          const text = resp?.choices?.[0]?.message?.content;
          if (typeof text === 'string') return text;
        } catch { /* ignore */ }
        return '';
      };

      const textOut = extractText(response);
      const words = (textOut || '').split(/\s+/g).filter(Boolean);

      // response.created
      try {
        const createdEvt = { type: 'response.created', response: { id: `resp_${requestId}`, model: model || 'unknown' } };
        res.write(`event: response.created\n`);
        res.write(`data: ${JSON.stringify(createdEvt)}\n\n`);
      } catch { /* ignore */ }

      // response.in_progress
      try {
        const inprog = { type: 'response.in_progress', response: { id: `resp_${requestId}`, model: model || 'unknown' } };
        res.write(`event: response.in_progress\n`);
        res.write(`data: ${JSON.stringify(inprog)}\n\n`);
      } catch { /* ignore */ }
      for (const w of words) {
        const delta = { type: 'response.output_text.delta', delta: w + ' ', response: { id: `resp_${requestId}`, model: model || 'unknown' } };
        res.write(`event: response.output_text.delta\n`);
        res.write(`data: ${JSON.stringify(delta)}\n\n`);
        await new Promise(r => setTimeout(r, 30));
      }

      // response.output_text.done
      try {
        const doneEvt = { type: 'response.output_text.done', response: { id: `resp_${requestId}`, model: model || 'unknown' } };
        res.write(`event: response.output_text.done\n`);
        res.write(`data: ${JSON.stringify(doneEvt)}\n\n`);
      } catch { /* ignore */ }

      // response.completed (attach total output_text when available)
      const completed = { type: 'response.completed', response: { id: `resp_${requestId}`, model: model || 'unknown', output_text: textOut || '' } };
      res.write(`event: response.completed\n`);
      res.write(`data: ${JSON.stringify(completed)}\n\n`);
      res.end();
    } catch (err) {
      try {
        const e = { error: { message: (err as Error).message || 'stream error', type: 'streaming_error', code: 'STREAM_FAILED' }, requestId };
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    }
  }
}
