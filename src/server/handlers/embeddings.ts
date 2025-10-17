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
      const response = await this.processEmbeddingsRequest(req, requestId);

      // Return JSON response
      const normalized = this.normalizeEmbeddingResponse(response);
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
  private async processEmbeddingsRequest(req: Request, requestId: string): Promise<EmbeddingResponse> {
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
  private async processWithPipeline(req: Request, requestId: string): Promise<EmbeddingResponse> {
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
    const out = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
      ? (pipelineResponse as Record<string, unknown>).data as EmbeddingResponse
      : pipelineResponse as EmbeddingResponse;
    if (out && typeof out === 'object' && modelId) {
      try { (out as any).model = modelId; } catch { /* ignore */ }
    }
    return out;
  }

  /**
   * Create simulated response for fallback
   */
  private createSimulatedResponse(req: Pick<Request, 'body'>): EmbeddingResponse {
    const inputs = Array.isArray(req.body.input) ? req.body.input : [req.body.input];
    const dimensions = req.body.dimensions || 1536;

    const embeddings: EmbeddingData[] = inputs.map((input: any, index: number) => ({
      object: 'embedding',
      embedding: this.generateMockEmbedding(dimensions),
      index,
    }));

    return {
      object: 'list',
      data: embeddings,
      model: req.body.model || 'text-embedding-3-small',
      usage: {
        prompt_tokens: this.estimateTokens(inputs),
        total_tokens: this.estimateTokens(inputs),
      },
    };
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

    return this.createSimulatedResponse({ body: {
      model: response?.model ?? 'text-embedding-3-small',
      input: Array.isArray(response?.input) ? response.input : [response?.input ?? ''],
      dimensions: response?.dimensions
    } } as Pick<Request, 'body'>);
  }

  /**
   * Generate mock embedding vector
   */
  private generateMockEmbedding(dimensions: number): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < dimensions; i++) {
      // Generate realistic-looking embedding values
      embedding.push(Math.random() * 2 - 1); // Random values between -1 and 1
    }

    // Normalize the embedding
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / magnitude);
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(inputs: any[]): number {
    let totalChars = 0;
    for (const input of inputs) {
      if (typeof input === 'string') {
        totalChars += input.length;
      }
    }
    // Rough estimate: ~4 characters per token
    return Math.ceil(totalChars / 4);
  }

  /**
   * Check if pipeline should be used
   */
  protected override shouldUsePipeline(): boolean {
    return super.shouldUsePipeline();
  }
}
