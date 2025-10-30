/**
 * Chat Completions Handler Implementation
 * Handles OpenAI-compatible chat completion requests
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { type RequestContext, type OpenAIChatCompletionRequest } from '../types.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ResponseNormalizer } from '../utils/response-normalizer.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { ProtocolDetector } from '../protocol/protocol-detector.js';
import { OpenAIAdapter } from '../protocol/openai-adapter.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { OpenAINormalizerLLMSwitch } from 'rcc-llmswitch-core/llmswitch/openai-normalizer';
import os from 'os';
import path from 'path';

/**
 * Chat Completions Handler
 * Handles /v1/chat/completions endpoint
 */
export class ChatCompletionsHandler extends BaseHandler {
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
   * Handle chat completions request
  */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    // Capture raw request for debugging
    try {
      const rawBody = JSON.parse(JSON.stringify((req as any).body || {}));
      (req as any).__rawBody = rawBody;
      const fs = await import('fs/promises');
      const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
      await (fs as any).mkdir(dir, { recursive: true });
      const rawFile = path.join(dir, `${requestId}_raw-request.json`);
      const payload = {
        requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: rawBody,
      };
      await (fs as any).writeFile(rawFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* ignore capture failures */ }

    this.logModule('ChatCompletionsHandler', 'request_start', {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length || 0,
      streaming: req.body.stream || false,
      tools: !!req.body.tools,
      timestamp: startTime,
    });

    try {
      // Optional: Replace/Inject system prompt into OpenAI Chat messages (mirrors Anthropic injection)
      try {
        const { shouldReplaceSystemPrompt, SystemPromptLoader, replaceSystemInOpenAIMessages } = await import('../../utils/system-prompt-loader.js');
        const sel = shouldReplaceSystemPrompt();
        if (sel) {
          const loader = SystemPromptLoader.getInstance();
          const sys = await loader.getPrompt(sel);
          const currentSys = (() => {
            try {
              const m = Array.isArray((req.body as any)?.messages) ? (req.body as any).messages[0] : null;
              return (m && typeof m === 'object' && (m as any).role === 'system' && typeof (m as any).content === 'string') ? String((m as any).content) : '';
            } catch { return ''; }
          })();
          const hasMdMarkers = /\bCLAUDE\.md\b|\bAGENT(?:S)?\.md\b/i.test(currentSys);
          if (sys && Array.isArray((req.body as any)?.messages) && !hasMdMarkers) {
            (req.body as any).messages = replaceSystemInOpenAIMessages((req.body as any).messages, sys) as any[];
            try { res.setHeader('x-rc-system-prompt-source', sel); } catch { /* ignore */ }
          }
        }
      } catch { /* non-blocking */ }

      // Strict protocol separation: Chat endpoint only accepts OpenAI Chat payload.
      // Do NOT auto-convert Anthropic/Responses-shaped payloads here to avoid cross-path pollution.
      try {
        const detector = new ProtocolDetector();
        const det = detector.detectFromRequest(req);
        const looksAnthropicContent = Array.isArray(req.body?.messages) && (req.body.messages as any[]).some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c && typeof c === 'object' && typeof c.type === 'string'));
        if (det.protocol === 'anthropic' || det.protocol === 'responses' || looksAnthropicContent) {
          throw new RouteCodexError('Chat endpoint only accepts OpenAI Chat payload (messages: string or OpenAI content parts). Use the Responses endpoint for Responses-shaped payloads.', 'invalid_protocol', 400);
        }
      } catch (e) {
        if (e instanceof RouteCodexError) throw e;
      }

      // Tool guidance和归一化在 llmswitch-core 的 OpenAI 工具阶段统一处理
      try { res.setHeader('x-rc-conversion-profile', 'openai-openai'); } catch { /* ignore */ }

      // Skip strict request validation (preserve raw inputs)

      // Process request through pipeline
      const pipelineResponse = await this.processChatRequest(req, requestId);

      // Handle streaming vs non-streaming response (also honor Accept: text/event-stream)
      const accept = String(req.headers['accept'] || '').toLowerCase();
      const wantsSSE = (accept.includes('text/event-stream') || req.body?.stream === true);
      if (wantsSSE) {
        const streamModel = (pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse)
          ? ((pipelineResponse as any).data?.model ?? req.body.model)
          : req.body.model;
        await this.streamingManager.streamResponse(pipelineResponse, requestId, res, streamModel);
        return;
      }

      // Return JSON response
      const payload = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
        ? (pipelineResponse as Record<string, unknown>).data
        : pipelineResponse;
      const normalized = this.responseNormalizer.normalizeOpenAIResponse(payload, 'chat');
      // Chat 路径不注入 Responses 的 required_action 结构，保持协议纯净
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      // If the client requested SSE streaming, emit an SSE error and end the stream
      try {
        const accept = String(req.headers['accept'] || '').toLowerCase();
        const wantsSSE = (accept.includes('text/event-stream') || req.body?.stream === true);
        if (wantsSSE && !res.writableEnded) {
          try {
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              try { res.setHeader('X-Accel-Buffering', 'no'); } catch { /* ignore */ }
              res.setHeader('x-request-id', requestId);
              try { (res as any).flushHeaders?.(); } catch { /* ignore */ }
            }
            const model = typeof req.body?.model === 'string' ? req.body.model : 'unknown';
            const errMsg = (error instanceof Error ? error.message : String(error)) || 'stream error';
            const errChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: `Error: ${errMsg}` }, finish_reason: 'error' }]
            } as any;
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            res.write(`data: [DONE]\n\n`);
          } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
          return;
        }
      } catch { /* ignore */ }

      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process chat completion request
   */
  private async processChatRequest(req: Request, requestId: string): Promise<any> {
    // Use pipeline manager only; no fallback allowed
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }
    throw new RouteCodexError('Chat pipeline unavailable (no route pools or pipeline manager)', 'pipeline_unavailable', 503);
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

    // Pre-convert OpenAI Responses payload to OpenAI Chat payload
    let chatPayload = { ...(req.body || {}) } as Record<string, unknown>;
    // 不在入口做跨路径的内容过滤；路径隔离在转换路由与编码器中保证。
    // 角色分布快照（llmswitch 前/后），便于诊断“tool 历史泄露”等问题
    const snapshotDir = (() => {
      try {
        const os = require('os'); const path = require('path'); const fs = require('fs');
        const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      } catch { return null; }
    })();
    const roleCounts = (msgs: any[]): Record<string, number> => {
      const c: Record<string, number> = { system: 0, user: 0, assistant: 0, tool: 0, unknown: 0 };
      for (const m of Array.isArray(msgs) ? msgs : []) {
        const r = String(m?.role || '').toLowerCase();
        if (r === 'system' || r === 'user' || r === 'assistant' || r === 'tool') c[r] += 1; else c.unknown += 1;
      }
      return c;
    };
    const writeSnapshot = (kind: 'pre-llmswitch' | 'post-llmswitch', payload: any) => {
      try {
        if (!snapshotDir) return;
        const fs = require('fs'); const path = require('path');
        const file = path.join(snapshotDir, `${requestId}_${kind}.json`);
        const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
        const stats = { kind, counts: roleCounts(msgs), total: msgs.length };
        fs.writeFileSync(file, JSON.stringify({ requestId, stats }, null, 2), 'utf-8');
      } catch { /* ignore */ }
    };
    try { writeSnapshot('pre-llmswitch', chatPayload); } catch { /* ignore */ }
    // Strict: normalize Chat request via llmswitch; if normalization fails, do not fallback
    {
      const logger = new PipelineDebugLogger({} as any, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const normalizer = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} } as any, deps as any);

      try {
        if (typeof normalizer.initialize === 'function') {
          await normalizer.initialize();
        }
        const transformed = await normalizer.transformRequest(req.body);
        if (transformed && typeof transformed === 'object') {
          const dto = transformed as any;
          chatPayload = dto?.data && typeof dto.data === 'object'
            ? { ...(dto.data as Record<string, unknown>) }
            : (transformed as Record<string, unknown>);
        }
      } catch (e) {
        throw new RouteCodexError((e as Error)?.message || 'chat normalization failed', 'conversion_error', 400);
      }
    }
    try { writeSnapshot('post-llmswitch', chatPayload); } catch { /* ignore */ }

    // Ensure payload model aligns with selected route meta
    const normalizedPayload = { ...chatPayload, ...(modelId ? { model: modelId } : {}) } as Record<string, unknown>;
    // Inject route.requestId into payload metadata for downstream providers (capture + pairing)
    try {
      const meta = (normalizedPayload as any)._metadata && typeof (normalizedPayload as any)._metadata === 'object'
        ? { ...(normalizedPayload as any)._metadata }
        : {};
      (normalizedPayload as any)._metadata = { ...meta, requestId };
    } catch { /* non-blocking */ }

    const pipelineRequest = {
      data: normalizedPayload,
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
        entryEndpoint: '/v1/chat/completions',
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

    return pipelineResponse;
  }

}
