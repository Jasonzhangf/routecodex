/**
 * OpenAI Router Implementation
 * Implements OpenAI API v1 compatibility endpoints with pass-through functionality
 */

import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import { RequestHandler } from '../core/request-handler.js';
import { ProviderManager } from '../core/provider-manager.js';
import {
  type RequestContext,
  type ResponseContext,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAIModel,
  type OpenAICompletionResponse,
  type StreamResponse,
  type StreamOptions,
  RouteCodexError,
  type ServerConfig
} from './types.js';
import { PassThroughProvider } from '../providers/pass-through-provider.js';

/**
 * OpenAI Router configuration interface
 */
export interface OpenAIRouterConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
}

/**
 * OpenAI Router class
 */
export class OpenAIRouter extends BaseModule {
  private router: Router;
  private moduleConfigReader: ModuleConfigReader;
  private requestHandler: RequestHandler;
  private providerManager: ProviderManager;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private config: OpenAIRouterConfig;
  private passThroughProvider: PassThroughProvider;
  private _isInitialized: boolean = false;

  constructor(
    requestHandler: RequestHandler,
    providerManager: ProviderManager,
    moduleConfigReader: ModuleConfigReader,
    config: OpenAIRouterConfig = {}
  ) {
    const moduleInfo: ModuleInfo = {
      id: 'openai-router',
      name: 'OpenAIRouter',
      version: '0.0.1',
      description: 'OpenAI API v1 compatibility router with pass-through',
      type: 'server'
    };

    super(moduleInfo);

    this.requestHandler = requestHandler;
    this.providerManager = providerManager;
    this.moduleConfigReader = moduleConfigReader;
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();
    this.router = express.Router();

    // Set default configuration
    this.config = {
      enableStreaming: true,
      enableMetrics: true,
      enableValidation: true,
      rateLimitEnabled: false,
      authEnabled: false,
      timeout: 30000,
      ...config
    };

    // Initialize pass-through provider
    this.passThroughProvider = new PassThroughProvider({
      targetUrl: this.config.targetUrl || 'https://api.openai.com/v1',
      timeout: this.config.timeout
    });
  }

  /**
   * Initialize the OpenAI router
   */
  public async initialize(): Promise<void> {
    try {
      await this.errorHandling.initialize();
      await this.passThroughProvider.initialize();

      // Setup routes
      this.setupRoutes();

      this._isInitialized = true;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'openai_router_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          config: this.config,
          targetUrl: this.config.targetUrl
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Get the Express router instance
   */
  public getRouter(): Router {
    return this.router;
  }

  /**
   * Setup OpenAI API routes
   */
  private setupRoutes(): void {
    // Chat Completions endpoint
    this.router.post('/chat/completions', this.handleChatCompletions.bind(this));

    // Completions endpoint
    this.router.post('/completions', this.handleCompletions.bind(this));

    // Models endpoint
    this.router.get('/models', this.handleModels.bind(this));

    // Model retrieval endpoint
    this.router.get('/models/:model', this.handleModel.bind(this));

    // Embeddings endpoint
    this.router.post('/embeddings', this.handleEmbeddings.bind(this));

    // Moderations endpoint
    this.router.post('/moderations', this.handleModerations.bind(this));

    // Image generation endpoint
    this.router.post('/images/generations', this.handleImageGenerations.bind(this));

    // Audio transcription endpoint
    this.router.post('/audio/transcriptions', this.handleAudioTranscriptions.bind(this));

    // Audio translation endpoint
    this.router.post('/audio/translations', this.handleAudioTranslations.bind(this));

    // File operations
    this.router.get('/files', this.handleFilesList.bind(this));
    this.router.post('/files', this.handleFileUpload.bind(this));
    this.router.delete('/files/:file_id', this.handleFileDelete.bind(this));
    this.router.get('/files/:file_id', this.handleFileRetrieve.bind(this));
    this.router.get('/files/:file_id/content', this.handleFileContent.bind(this));

    // Fine-tuning operations
    this.router.post('/fine_tuning/jobs', this.handleFineTuningCreate.bind(this));
    this.router.get('/fine_tuning/jobs', this.handleFineTuningList.bind(this));
    this.router.get('/fine_tuning/jobs/:fine_tuning_job_id', this.handleFineTuningRetrieve.bind(this));
    this.router.post('/fine_tuning/jobs/:fine_tuning_job_id/cancel', this.handleFineTuningCancel.bind(this));
    this.router.get('/fine_tuning/jobs/:fine_tuning_job_id/events', this.handleFineTuningEvents.bind(this));

    // Batch operations
    this.router.post('/batches', this.handleBatchCreate.bind(this));
    this.router.get('/batches/:batch_id', this.handleBatchRetrieve.bind(this));
    this.router.get('/batches', this.handleBatchList.bind(this));
    this.router.post('/batches/:batch_id/cancel', this.handleBatchCancel.bind(this));

    // API version info
    this.router.get('/assistants', this.handleAssistants.bind(this));
  }

  /**
   * Handle chat completions
   */
  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          model: req.body.model,
          messageCount: req.body.messages?.length || 0,
          streaming: req.body.stream || false
        }
      });

      // Create request context
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      // Validate request
      if (this.config.enableValidation) {
        const validation = this.validateChatCompletionRequest(req.body);
        if (!validation.isValid) {
          throw new RouteCodexError(
            `Request validation failed: ${validation.errors.join(', ')}`,
            'validation_error',
            400
          );
        }
      }

      let response;

      if (req.body.stream && this.config.enableStreaming) {
        // Handle streaming response
        await this.handleStreamingChatCompletion(req.body, context, res);
        return; // Streaming handles the response directly
      } else {
        // Handle regular response with pass-through
        response = await this.passThroughProvider.processChatCompletion(req.body, {
          timeout: this.config.timeout,
          retryAttempts: 3
        });
      }

      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          status: 200,
          model: req.body.model,
          streaming: req.body.stream || false
        }
      });

      // Send response
      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'chat_completions_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      // Send error response
      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle completions
   */
  private async handleCompletions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          model: req.body.model,
          promptLength: Array.isArray(req.body.prompt) ? req.body.prompt.length : req.body.prompt?.length || 0,
          streaming: req.body.stream || false
        }
      });

      // Create request context
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      // Validate request
      if (this.config.enableValidation) {
        const validation = this.validateCompletionRequest(req.body);
        if (!validation.isValid) {
          throw new RouteCodexError(
            `Request validation failed: ${validation.errors.join(', ')}`,
            'validation_error',
            400
          );
        }
      }

      // Process with pass-through provider
      const response = await this.passThroughProvider.processCompletion(req.body, {
        timeout: this.config.timeout,
        retryAttempts: 3
      });

      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          status: 200,
          model: req.body.model
        }
      });

      // Send response
      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'completions_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      // Send error response
      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle models list
   */
  private async handleModels(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'models_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId
        }
      });

      // Get models from pass-through provider
      const response = await this.passThroughProvider.getModels();

      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'models_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          modelCount: Array.isArray(response) ? response.length : (response && typeof response === 'object' && 'data' in response ? (response as any).data.length : 0)
        }
      });

      // Send response
      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'models_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'models_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      // Send error response
      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle specific model retrieval
   */
  private async handleModel(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const modelId = req.params.model;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'model_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          modelId
        }
      });

      // Get specific model from pass-through provider
      const response = await this.passThroughProvider.getModel(modelId);

      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'model_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          modelId
        }
      });

      // Send response
      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'model_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'model_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          modelId,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      // Send error response
      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle embeddings (pass-through)
   */
  private async handleEmbeddings(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      const response = await this.passThroughProvider.processEmbeddings(req.body, context);
      const duration = Date.now() - startTime;

      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'embeddings_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle moderations (pass-through)
   */
  private async handleModerations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      const response = await this.passThroughProvider.processModerations(req.body, context);
      const duration = Date.now() - startTime;

      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'moderations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle image generations (pass-through)
   */
  private async handleImageGenerations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      const response = await this.passThroughProvider.processImageGenerations(req.body, context);
      const duration = Date.now() - startTime;

      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'image_generations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle audio transcriptions (pass-through)
   */
  private async handleAudioTranscriptions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      const response = await this.passThroughProvider.processAudioTranscriptions(req.body, context);
      const duration = Date.now() - startTime;

      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'audio_transcriptions_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  /**
   * Handle audio translations (pass-through)
   */
  private async handleAudioTranslations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip
      };

      const response = await this.passThroughProvider.processAudioTranslations(req.body, context);
      const duration = Date.now() - startTime;

      res.status(200).json(response);

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'audio_translations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal Server Error',
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error'
        }
      });
    }
  }

  // Placeholder handlers for file operations
  private async handleFilesList(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Files API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFileUpload(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Files API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFileDelete(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Files API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFileRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Files API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFileContent(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Files API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  // Placeholder handlers for fine-tuning operations
  private async handleFineTuningCreate(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Fine-tuning API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFineTuningList(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Fine-tuning API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFineTuningRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Fine-tuning API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFineTuningCancel(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Fine-tuning API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleFineTuningEvents(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Fine-tuning API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  // Placeholder handlers for batch operations
  private async handleBatchCreate(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Batch API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleBatchRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Batch API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleBatchList(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Batch API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleBatchCancel(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Batch API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  private async handleAssistants(req: Request, res: Response): Promise<void> {
    res.status(501).json({ error: { message: 'Assistants API not implemented in pass-through mode', type: 'not_implemented' } });
  }

  /**
   * Handle streaming chat completion
   */
  private async handleStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    context: RequestContext,
    res: Response
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Set appropriate headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Transfer-Encoding', 'chunked');

      // Send the initial response
      const initialResponse: StreamResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: undefined
          }
        ]
      };

      res.write(`data: ${JSON.stringify(initialResponse)}\n\n`);

      // Simulate streaming response (in real implementation, this would stream from the provider)
      const contentChunks = this.splitIntoChunks('This is a simulated streaming response. In a real implementation, this would stream from the target provider.', 10);

      let chunkIndex = 0;
      const sendChunks = () => {
        if (chunkIndex < contentChunks.length) {
          const chunkResponse: StreamResponse = {
            id: initialResponse.id,
            object: 'chat.completion.chunk',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { content: contentChunks[chunkIndex] },
                finish_reason: undefined
              }
            ]
          };

          res.write(`data: ${JSON.stringify(chunkResponse)}\n\n`);
          chunkIndex++;
          setTimeout(sendChunks, 50); // Simulate streaming delay
        } else {
          // Send final message
          const finalResponse: StreamResponse = {
            id: initialResponse.id,
            object: 'chat.completion.chunk',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }
            ]
          };

          res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();

          // Return the aggregated response
          resolve({
            id: initialResponse.id,
            object: 'chat.completion',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: contentChunks.join('')
                },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          });
        }
      };

      sendChunks();
    });
  }

  /**
   * Split text into chunks for streaming
   */
  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Validate chat completion request
   */
  private validateChatCompletionRequest(request: OpenAIChatCompletionRequest): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      errors.push('Messages are required and must be a non-empty array');
    }

    // Validate messages
    if (request.messages && Array.isArray(request.messages)) {
      for (let i = 0; i < request.messages.length; i++) {
        const message = request.messages[i];
        if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
          errors.push(`Message ${i} has invalid role: ${message.role}`);
        }

        if (!message.content || typeof message.content !== 'string') {
          errors.push(`Message ${i} has invalid content: must be a string`);
        }
      }
    }

    // Validate numeric fields
    if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens < 1)) {
      errors.push('max_tokens must be a positive number');
    }

    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)) {
      errors.push('top_p must be a number between 0 and 1');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate completion request
   */
  private validateCompletionRequest(request: OpenAICompletionRequest): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.prompt || (typeof request.prompt !== 'string' && !Array.isArray(request.prompt))) {
      errors.push('Prompt is required and must be a string or array of strings');
    }

    // Validate numeric fields
    if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens < 1)) {
      errors.push('max_tokens must be a positive number');
    }

    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)) {
      errors.push('top_p must be a number between 0 and 1');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Sanitize headers for logging
   */
  private sanitizeHeaders(headers: any): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = ['authorization', 'api-key', 'x-api-key', 'cookie'];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = String(value);
      }
    }

    return sanitized;
  }

  /**
   * Handle error with error handling center
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `openai-router.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: 'openai-router',
        context: {
          stack: error.stack,
          name: error.name
        }
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Stop the OpenAI router
   */
  public async stop(): Promise<void> {
    try {
      if (this.passThroughProvider) {
        await this.passThroughProvider.destroy();
      }
      await this.errorHandling.destroy();
    } catch (error) {
      console.error('Error stopping OpenAI router:', error);
    }
  }
}