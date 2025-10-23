/**
 * Embeddings Handler Implementation
 * Handles embedding generation requests for all protocols
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ProtocolDetector } from '../protocol/protocol-detector.js';
import { OpenAIAdapter } from '../protocol/openai-adapter.js';

/**
 * Embedding data interface
 */
export interface EmbeddingData {
  object: string;
  embedding: number[];
  index: number;
}

/**
 * Embedding response interface
 */
export interface EmbeddingResponse {
  object: string;
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Embeddings Handler
 * Handles /v1/embeddings endpoint for all protocol compatibility
 */
export class EmbeddingsHandler extends BaseHandler {
  private requestValidator: RequestValidator;

  constructor(config: ProtocolHandlerConfig) {
    super(config);
    this.requestValidator = new RequestValidator();
  }

  /**
   * Handle embeddings request
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    this.logger.logModule(this.constructor.name, 'request_start', {
      requestId,
      model: req.body.model,
      inputType: Array.isArray(req.body.input) ? 'array' : 'string',
      inputLength: Array.isArray(req.body.input) ? req.body.input.length : (req.body.input?.length || 0),
      dimensions: req.body.dimensions,
      timestamp: startTime,
    });

    try {
      // Forced adapter preflight: if payload is Anthropic/Responses-shaped, normalize to OpenAI embeddings-compatible
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
      const validation = this.requestValidator.validateEmbedding(req.body);
      if (!validation.isValid) {
        throw new RouteCodexError(
          `Request validation failed: ${validation.errors.join(', ')}`,
          'validation_error',
          400
        );
      }

      // Process request
      const pipelineResponse = await this.processEmbeddingsRequest(req, requestId);

      // Return JSON response
      const payload = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
        ? (pipelineResponse as Record<string, unknown>).data
        : pipelineResponse;
      const normalized = this.normalizeEmbeddingResponse(payload);
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process embeddings request
   */
  private async processEmbeddingsRequest(req: Request, requestId: string): Promise<any> {
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }

    throw new RouteCodexError('Embeddings pipeline unavailable', 'pipeline_unavailable', 503);
  }

  /**
   * Process request through pipeline
   */
  private async processWithPipeline(req: Request, requestId: string): Promise<any> {
    const routeName = await this.decideRouteCategoryAsync(req, '/v1/embeddings');
    const pipelineId = this.pickPipelineId(routeName);
    const routeMeta = this.getRouteMeta();
    const meta = routeMeta ? routeMeta[pipelineId] : undefined;
    const providerId = meta?.providerId ?? 'unknown';
    const modelId = meta?.modelId ?? 'unknown';

    const pipelineRequest = {
      data: {
        model: req.body.model,
        input: req.body.input,
        dimensions: req.body.dimensions,
        encoding_format: req.body.encoding_format,
        user: req.body.user,
      },
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

    // Align returned payload's model with route meta if set
    if (
      modelId &&
      pipelineResponse &&
      typeof pipelineResponse === 'object' &&
      'data' in pipelineResponse &&
      (pipelineResponse as any).data &&
      typeof (pipelineResponse as any).data === 'object'
    ) {
      try { (pipelineResponse as any).data.model = modelId; } catch { /* ignore */ }
    }
    return pipelineResponse;
  }

  private normalizeEmbeddingResponse(response: any): EmbeddingResponse {
    if (response && typeof response === 'object') {
      const data = Array.isArray((response as any).data) ? (response as any).data : [];
      const usage = (response as any).usage || {};
      if (data.length) {
        return {
          object: (response as any).object ?? 'list',
          data,
          model: (response as any).model ?? 'unknown',
          usage: {
            prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
            total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? usage.input_tokens ?? 0)
          }
        };
      }
    }

    throw new RouteCodexError('Invalid embedding response payload', 'invalid_pipeline_response', 502);
  }

  /**
   * Check if pipeline should be used
   */
  protected override shouldUsePipeline(): boolean {
    return super.shouldUsePipeline();
  }
}
