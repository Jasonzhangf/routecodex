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
import { emitOpenAIChatSSE } from '../utils/openai-chunk-emitter.js';
// Protocol conversion is owned by llmswitch modules. Handler must not pre-convert.
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { OpenAINormalizerLLMSwitch } from '../../modules/pipeline/modules/llmswitch/llmswitch-openai-openai.js';
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
      const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'chat-replay');
      await (fs as any).mkdir(dir, { recursive: true });
      const rawFile = path.join(dir, `raw-request_${requestId}.json`);
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
      // Validate only when payload already looks like OpenAI Chat; protocol conversion belongs to llmswitch
      try {
        const looksChat = Array.isArray((req.body as any)?.messages) && typeof (req.body as any)?.model === 'string';
        if (looksChat) {
          const validation = this.requestValidator.validateChatCompletion(req.body);
          if (!validation.isValid) {
            throw new RouteCodexError(
              `Request validation failed: ${validation.errors.join(', ')}`,
              'validation_error',
              400
            );
          }
        }
      } catch { /* keep handler permissive; conversion/strict validation occurs in llmswitch */ }

      // Process request through pipeline
      const pipelineResponse = await this.processChatRequest(req, requestId);

      // Handle streaming vs non-streaming response
      if (req.body.stream) {
        // Phase 2: stream emission via workflow-owned emitter (Chat-only)
        try { res.setHeader('Content-Type', 'text/event-stream'); } catch { /* ignore */ }
        try { res.setHeader('Cache-Control', 'no-cache'); } catch { /* ignore */ }
        try { res.setHeader('Connection', 'keep-alive'); } catch { /* ignore */ }
        try { res.setHeader('x-request-id', requestId); } catch { /* ignore */ }
        const payload = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
          ? (pipelineResponse as Record<string, unknown>).data
          : pipelineResponse;
        const streamModel = (payload as any)?.model ?? req.body.model;
        await emitOpenAIChatSSE(res, payload, requestId, streamModel);
        return;
      }

      // Return JSON response
      const payload = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
        ? (pipelineResponse as Record<string, unknown>).data
        : pipelineResponse;
      const normalized = this.responseNormalizer.normalizeOpenAIResponse(payload, 'chat');
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
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

    // Do not perform protocol conversion here; delegate to llmswitch inside pipeline.
    // Ensure payload carries route-selected model for downstream modules when applicable.
    const normalizedPayload = { ...(req.body || {}), ...(modelId ? { model: modelId } : {}) } as Record<string, unknown>;

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

    const pipelineTimeoutMs = Number(process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS || 300000);
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);

    return pipelineResponse;
  }

}
