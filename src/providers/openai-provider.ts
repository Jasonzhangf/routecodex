/**
 * OpenAI Compatible Provider
 * Implements OpenAI API compatible provider
 */

import { BaseProvider, type ProviderResponse, type ProviderHealth } from './base-provider.js';
import {
  type ProviderConfig,
  type ModelConfig,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAICompletionResponse,
  /* type OpenAIModel, */
  type StreamOptions,
  /* type StreamResponse, */
  RouteCodexError,
} from '../server/types.js';
import type { UnknownObject } from '../types/common-types.js';

/**
 * OpenAI API response format
 */
interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}

/**
 * OpenAI Compatible Provider implementation
 */
export class OpenAIProvider extends BaseProvider {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(config: ProviderConfig) {
    super(config);

    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/0.0.1',
      ...config.headers,
    };

    if (config.apiKey) {
      this.defaultHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  /**
   * Process chat completion request
   */
  public async processChatCompletion(
    request: OpenAIChatCompletionRequest,
    options: { timeout?: number; retryAttempts?: number } = {}
  ): Promise<ProviderResponse> {
    const startTime = Date.now();
    const timeout = options.timeout || this.config.timeout || 30000;
    const retryAttempts = options.retryAttempts || this.config.retryAttempts || 3;

    try {
      // Check rate limit
      const rateLimitCheck = this.checkRateLimit('chat_completion');
      if (!rateLimitCheck.allowed) {
        throw new RouteCodexError('Rate limit exceeded', 'rate_limit_exceeded', 429, {
          meta: { resetTime: rateLimitCheck.resetTime ?? null } as unknown as UnknownObject,
        });
      }

      // Validate model
      if (!this.isModelSupported(request.model)) {
        throw new RouteCodexError(
          `Model '${request.model}' is not supported`,
          'model_not_supported',
          400
        );
      }

      // Get model config
      const modelConfig = this.getModelConfig(request.model);
      if (!modelConfig) {
        throw new RouteCodexError(
          `Model configuration not found for '${request.model}'`,
          'model_config_not_found',
          404
        );
      }

      // Prepare request payload
      const payload = this.prepareChatCompletionPayload(request, modelConfig);

      // Make API request with retry logic
      const response = await this.makeRequestWithRetry(
        '/chat/completions',
        payload,
        timeout,
        retryAttempts
      );

      // Parse response
      const completionResponse = this.parseChatCompletionResponse(response.data);

      // Update statistics
      const duration = Date.now() - startTime;
      const tokens = completionResponse.usage?.total_tokens || 0;
      this.updateStats(true, duration, tokens);

      return this.createResponse(
        true,
        completionResponse,
        undefined,
        response.statusCode,
        response.headers,
        duration,
        completionResponse.usage
          ? {
              promptTokens: completionResponse.usage.prompt_tokens,
              completionTokens: completionResponse.usage.completion_tokens,
              totalTokens: completionResponse.usage.total_tokens,
            }
          : undefined
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);

      if (error instanceof RouteCodexError) {
        return this.createResponse(
          false,
          undefined,
          error.message,
          error.status,
          undefined,
          duration
        );
      }

      await this.handleError(error as Error, 'chat_completion');
      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Process completion request
   */
  public async processCompletion(
    request: OpenAICompletionRequest,
    options: { timeout?: number; retryAttempts?: number } = {}
  ): Promise<ProviderResponse> {
    const startTime = Date.now();
    const timeout = options.timeout || this.config.timeout || 30000;
    const retryAttempts = options.retryAttempts || this.config.retryAttempts || 3;

    try {
      // Check rate limit
      const rateLimitCheck = this.checkRateLimit('completion');
      if (!rateLimitCheck.allowed) {
        throw new RouteCodexError('Rate limit exceeded', 'rate_limit_exceeded', 429, {
          meta: { resetTime: rateLimitCheck.resetTime ?? null } as unknown as UnknownObject,
        });
      }

      // Validate model
      if (!this.isModelSupported(request.model)) {
        throw new RouteCodexError(
          `Model '${request.model}' is not supported`,
          'model_not_supported',
          400
        );
      }

      // Get model config
      const modelConfig = this.getModelConfig(request.model);
      if (!modelConfig) {
        throw new RouteCodexError(
          `Model configuration not found for '${request.model}'`,
          'model_config_not_found',
          404
        );
      }

      // Prepare request payload
      const payload = this.prepareCompletionPayload(request, modelConfig);

      // Make API request with retry logic
      const response = await this.makeRequestWithRetry(
        '/completions',
        payload,
        timeout,
        retryAttempts
      );

      // Parse response
      const completionResponse = this.parseCompletionResponse(response.data);

      // Update statistics
      const duration = Date.now() - startTime;
      const tokens = completionResponse.usage?.total_tokens || 0;
      this.updateStats(true, duration, tokens);

      return this.createResponse(
        true,
        completionResponse,
        undefined,
        response.statusCode,
        response.headers,
        duration,
        completionResponse.usage
          ? {
              promptTokens: completionResponse.usage.prompt_tokens,
              completionTokens: completionResponse.usage.completion_tokens,
              totalTokens: completionResponse.usage.total_tokens,
            }
          : undefined
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);

      if (error instanceof RouteCodexError) {
        return this.createResponse(
          false,
          undefined,
          error.message,
          error.status,
          undefined,
          duration
        );
      }

      await this.handleError(error as Error, 'completion');
      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Process streaming chat completion
   */
  public async processStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    options: StreamOptions
  ): Promise<ProviderResponse> {
    const startTime = Date.now();

    try {
      // Check rate limit
      const rateLimitCheck = this.checkRateLimit('streaming_chat_completion');
      if (!rateLimitCheck.allowed) {
        throw new RouteCodexError('Rate limit exceeded', 'rate_limit_exceeded', 429, {
          meta: { resetTime: rateLimitCheck.resetTime ?? null } as unknown as UnknownObject,
        });
      }

      // Validate model
      if (!this.isModelSupported(request.model)) {
        throw new RouteCodexError(
          `Model '${request.model}' is not supported`,
          'model_not_supported',
          400
        );
      }

      // Get model config
      const modelConfig = this.getModelConfig(request.model);
      if (!modelConfig) {
        throw new RouteCodexError(
          `Model configuration not found for '${request.model}'`,
          'model_config_not_found',
          404
        );
      }

      // Check if streaming is supported
      if (!modelConfig.supportsStreaming) {
        throw new RouteCodexError(
          `Streaming is not supported for model '${request.model}'`,
          'streaming_not_supported',
          400
        );
      }

      // Prepare request payload
      const payload = this.prepareChatCompletionPayload(request, modelConfig);
      payload.stream = true;

      // Make streaming request as AsyncIterable producing parsed JSON chunks
      const iterator = (async function* makeIterator(self: OpenAIProvider, endpoint: string, body: any, opts: StreamOptions) {
        const url = `${self.baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), opts.timeout || 30000);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { ...self.defaultHeaders, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            const errorData = await response.text();
            throw new RouteCodexError(`Stream request failed: ${errorData}`,'stream_error',response.status);
          }
          const reader = response.body?.getReader();
          if (!reader) { throw new RouteCodexError('Stream reader not available','stream_reader_error',500); }
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) {break;}
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) {continue;}
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                if (opts.onComplete) { try { opts.onComplete(); } catch { /* ignore */ } }
                return;
              }
              try {
                if (opts.onChunk) { try { opts.onChunk(data); } catch { /* ignore */ } }
                const obj = JSON.parse(data);
                yield obj;
              } catch {
                // ignore malformed lines
              }
            }
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') {
            if (opts.onError) { try { opts.onError(new RouteCodexError('Stream timeout','stream_timeout',408)); } catch { /* ignore */ } }
            throw new RouteCodexError('Stream timeout','stream_timeout',408);
          }
          if (opts.onError) { try { opts.onError(e as Error); } catch { /* ignore */ } }
          throw e;
        }
      })(this, '/chat/completions', payload, options);

      // Update statistics and return async iterator as data
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return this.createResponse(true, iterator, undefined, 200, { 'Content-Type': 'text/event-stream' }, duration);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);

      if (error instanceof RouteCodexError) {
        return this.createResponse(
          false,
          undefined,
          error.message,
          error.status,
          undefined,
          duration
        );
      }

      await this.handleError(error as Error, 'streaming_chat_completion');
      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Prepare chat completion payload
   */
  private prepareChatCompletionPayload(
    request: OpenAIChatCompletionRequest,
    modelConfig: ModelConfig
  ): any {
    const payload: any = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens || modelConfig.maxTokens,
      temperature: request.temperature ?? modelConfig.temperature ?? 0.7,
      top_p: request.top_p ?? modelConfig.topP ?? 1.0,
    };

    // Add optional parameters
    if (request.frequency_penalty !== undefined) {
      payload.frequency_penalty = request.frequency_penalty;
    }

    if (request.presence_penalty !== undefined) {
      payload.presence_penalty = request.presence_penalty;
    }

    if (request.stop !== undefined) {
      payload.stop = request.stop;
    }

    if (request.tools !== undefined) {
      payload.tools = request.tools;
    }

    if (request.tool_choice !== undefined) {
      payload.tool_choice = request.tool_choice;
    }

    if (request.user !== undefined) {
      payload.user = request.user;
    }

    return payload;
  }

  /**
   * Prepare completion payload
   */
  private prepareCompletionPayload(
    request: OpenAICompletionRequest,
    modelConfig: ModelConfig
  ): any {
    const payload: any = {
      model: request.model,
      prompt: request.prompt,
      max_tokens: request.max_tokens || modelConfig.maxTokens,
      temperature: request.temperature ?? modelConfig.temperature ?? 0.7,
      top_p: request.top_p ?? modelConfig.topP ?? 1.0,
    };

    // Add optional parameters
    if (request.suffix !== undefined) {
      payload.suffix = request.suffix;
    }

    if (request.n !== undefined) {
      payload.n = request.n;
    }

    if (request.logprobs !== undefined) {
      payload.logprobs = request.logprobs;
    }

    if (request.echo !== undefined) {
      payload.echo = request.echo;
    }

    if (request.stop !== undefined) {
      payload.stop = request.stop;
    }

    if (request.presence_penalty !== undefined) {
      payload.presence_penalty = request.presence_penalty;
    }

    if (request.frequency_penalty !== undefined) {
      payload.frequency_penalty = request.frequency_penalty;
    }

    if (request.best_of !== undefined) {
      payload.best_of = request.best_of;
    }

    if (request.logit_bias !== undefined) {
      payload.logit_bias = request.logit_bias;
    }

    if (request.user !== undefined) {
      payload.user = request.user;
    }

    return payload;
  }

  /**
   * Make HTTP request with retry logic
   */
  private async makeRequestWithRetry(
    endpoint: string,
    payload: any,
    timeout: number,
    retryAttempts: number
  ): Promise<{ data: any; statusCode: number; headers: Record<string, string> }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        const response = await this.makeHttpRequest(endpoint, payload, timeout);
        return response;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on certain errors
        if (error instanceof RouteCodexError) {
          if (error.status === 400 || error.status === 401 || error.status === 403) {
            throw error;
          }
        }

        // Wait before retry (exponential backoff)
        if (attempt < retryAttempts) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, etc.
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Request failed after all retry attempts');
  }

  /**
   * Make HTTP request
   */
  private async makeHttpRequest(
    endpoint: string,
    payload: any,
    timeout: number
  ): Promise<{ data: any; statusCode: number; headers: Record<string, string> }> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: this.defaultHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseData = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      if (!response.ok) {
        let errorData: OpenAIErrorResponse;
        try {
          errorData = JSON.parse(responseData);
        } catch {
          errorData = { error: { message: responseData, type: 'unknown' } };
        }

        throw new RouteCodexError(errorData.error.message, errorData.error.type, response.status, {
          response: (errorData as unknown) as UnknownObject,
        });
      }

      const data = JSON.parse(responseData);
      return { data, statusCode: response.status, headers };
    } catch (error) {
      if (error instanceof RouteCodexError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new RouteCodexError('Request timeout', 'timeout_error', 408);
      }

      throw new RouteCodexError(
        error instanceof Error ? error.message : String(error),
        'network_error',
        500
      );
    }
  }

  /**
   * Make streaming HTTP request
   */
  private async makeStreamingRequest(
    endpoint: string,
    payload: any,
    options: StreamOptions
  ): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const chunks: string[] = [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.defaultHeaders,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.text();
        throw new RouteCodexError(
          `Stream request failed: ${errorData}`,
          'stream_error',
          response.status
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new RouteCodexError('Stream reader not available', 'stream_reader_error', 500);
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              if (options.onComplete) {
                options.onComplete();
              }
              return { chunks, complete: true };
            }

            try {
              // const parsed = JSON.parse(data);
              chunks.push(data);
              if (options.onChunk) {
                options.onChunk(data);
              }
            } catch (error) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      }

      return { chunks, complete: true };
    } catch (error) {
      if (error instanceof RouteCodexError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new RouteCodexError('Stream timeout', 'stream_timeout', 408);
      }

      if (options.onError) {
        options.onError(error as Error);
      }

      throw new RouteCodexError(
        error instanceof Error ? error.message : String(error),
        'stream_error',
        500
      );
    }
  }

  /**
   * Parse chat completion response
   */
  private parseChatCompletionResponse(data: any): OpenAICompletionResponse {
    return {
      id: data.id,
      object: data.object,
      created: data.created,
      model: data.model,
      choices: data.choices,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
          }
        : undefined,
    };
  }

  /**
   * Parse completion response
   */
  private parseCompletionResponse(data: any): OpenAICompletionResponse {
    return {
      id: data.id,
      object: data.object,
      created: data.created,
      model: data.model,
      choices: data.choices,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
          }
        : undefined,
    };
  }

  /**
   * Health check specific to OpenAI provider
   */
  public async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();

    try {
      // Try to get models as a health check
      await this.getModels();

      this.health.status = 'healthy';
      this.health.responseTime = Date.now() - startTime;
      this.health.lastCheck = new Date().toISOString();
      this.health.error = undefined;
    } catch (error) {
      this.health.status = 'unhealthy';
      this.health.responseTime = Date.now() - startTime;
      this.health.lastCheck = new Date().toISOString();
      this.health.error = error instanceof Error ? error.message : String(error);

      await this.handleError(error as Error, 'health_check');
    }

    return { ...this.health };
  }
}
