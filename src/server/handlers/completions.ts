/**
 * Completions Handler Implementation
 * Handles OpenAI-compatible text completion requests
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { type RequestContext, type OpenAICompletionRequest } from '../types.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ResponseNormalizer } from '../utils/response-normalizer.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { ProtocolDetector } from '../protocol/protocol-detector.js';
import { OpenAIAdapter } from '../protocol/openai-adapter.js';

/**
 * Completions Handler
 * Handles /v1/completions endpoint
 */
export class CompletionsHandler extends BaseHandler {
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
   * Handle completions request
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    this.logger.logModule(this.constructor.name, 'request_start', {
      requestId,
      model: req.body.model,
      prompt: req.body.prompt ? (typeof req.body.prompt === 'string' ? req.body.prompt.substring(0, 100) : 'Array') : null,
      streaming: req.body.stream || false,
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
          req.body = adapter.convertFromProtocol(req.body, 'anthropic') as any;
          try { res.setHeader('x-rc-adapter', 'anthropic->openai'); } catch { /* ignore */ }
        }
      } catch { /* non-blocking */ }

      // Validate request
      const validation = this.requestValidator.validateCompletion(req.body);
      if (!validation.isValid) {
        throw new RouteCodexError(
          `Request validation failed: ${validation.errors.join(', ')}`,
          'validation_error',
          400
        );
      }

      // Process request through pipeline
      const pipelineResponse = await this.processCompletionRequest(req, requestId);

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
      const normalized = this.responseNormalizer.normalizeOpenAIResponse(payload, 'completion');
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process completion request
   */
  private async processCompletionRequest(req: Request, requestId: string): Promise<any> {
    if (this.config.enablePipeline && this.shouldUsePipeline()) {
      return await this.processWithPipeline(req, requestId);
    }

    throw new RouteCodexError('Completions pipeline unavailable', 'pipeline_unavailable', 503);
  }

  /**
   * Process request through pipeline
   */
  private async processWithPipeline(req: Request, requestId: string): Promise<any> {
    // Similar to ChatCompletionsHandler but for completion format
    const pipelineRequest = {
      data: {
        model: req.body.model,
        prompt: req.body.prompt,
        max_tokens: req.body.max_tokens,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        frequency_penalty: req.body.frequency_penalty,
        presence_penalty: req.body.presence_penalty,
        stop: req.body.stop,
        stream: req.body.stream,
        logprobs: req.body.logprobs,
        echo: req.body.echo,
        n: req.body.n,
        best_of: req.body.best_of,
        logit_bias: req.body.logit_bias,
        suffix: req.body.suffix,
      },
      route: {
        providerId: 'default',
        modelId: req.body.model || 'unknown',
        requestId,
        timestamp: Date.now(),
        pipelineId: 'completion',
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
      this.executePipelineRequest(pipelineRequest),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs))
      )
    ]);

    return pipelineResponse;
  }

  /**
   * Execute pipeline request
   */
  private async executePipelineRequest(request: any): Promise<any> {
    try {
      const pipelineManager = this.getPipelineManager();

      if (!pipelineManager || typeof pipelineManager.processRequest !== 'function') {
        throw new RouteCodexError('Pipeline manager not available', 'pipeline_unavailable', 503);
      }

      // Align requested model with selected route meta if available
      if (this.getRouteMeta) {
        try {
          const routeMeta = this.getRouteMeta();
          const pid = request?.route?.pipelineId as string;
          const meta = pid && routeMeta ? routeMeta[pid] : undefined;
          if (meta?.modelId) {
            request.data = { ...(request.data || {}), model: meta.modelId };
          }
        } catch { /* ignore */ }
      }
      return await pipelineManager.processRequest(request);
    } catch (error) {
      this.logError(error, { context: 'executePipelineRequest' });
      throw error;
    }
  }

  /**
   * Check if pipeline should be used
   */
  protected override shouldUsePipeline(): boolean {
    return super.shouldUsePipeline() && typeof process !== 'undefined';
  }
}
