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
      // Forced adapter preflight: convert Anthropic/Responses-shaped payloads to OpenAI
      try {
        const looksAnthropicContent = Array.isArray(req.body?.messages) && (req.body.messages as any[]).some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c && typeof c === 'object' && c.type));
        const detector = new ProtocolDetector();
        const det = detector.detectFromRequest(req);
        if (looksAnthropicContent || det.protocol === 'anthropic' || det.protocol === 'responses') {
          const adapter = new OpenAIAdapter();
          let converted = adapter.convertFromProtocol(req.body, 'anthropic') as any;
          // Fallback normalization: ensure messages[].content is string
          if (Array.isArray(converted?.messages)) {
            converted = {
              ...converted,
              messages: (converted.messages as any[]).map((m: any) => {
                if (Array.isArray(m?.content)) {
                  const text = m.content
                    .filter((c: any) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
                    .map((c: any) => c.text)
                    .join('\n');
                  return { ...m, content: text };
                }
                return m;
              })
            };
          }
          req.body = converted;
          try { res.setHeader('x-rc-adapter', 'anthropic->openai'); } catch { /* ignore */ }
        }
      } catch { /* non-blocking */ }

      // Validate request
      const validation = this.requestValidator.validateChatCompletion(req.body);
      if (!validation.isValid) {
        throw new RouteCodexError(
          `Request validation failed: ${validation.errors.join(', ')}`,
          'validation_error',
          400
        );
      }

      // Process request through pipeline
      const pipelineResponse = await this.processChatRequest(req, requestId);

      // Handle streaming vs non-streaming response
      if (req.body.stream) {
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

    // Pre-convert OpenAI Responses payload to OpenAI Chat payload
    let chatPayload = { ...(req.body || {}) } as Record<string, unknown>;
    try {
      const logger = new PipelineDebugLogger({} as any, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const normalizer = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} } as any, deps as any);

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
    } catch {
      // Non-blocking: use original payload if normalization fails
    }

    // Ensure payload model aligns with selected route meta
    const normalizedPayload = { ...chatPayload, ...(modelId ? { model: modelId } : {}) };

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
