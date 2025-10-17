import express, { type Request, type Response, type Router } from 'express';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';

import { RequestHandler } from '../core/request-handler.js';
import { ProviderManager } from '../core/provider-manager.js';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import {
  ServiceContainer,
  initializeDefaultServices,
  ServiceTokens
} from './core/service-container.js';
import { ChatCompletionsHandler } from './handlers/chat-completions.js';
import { CompletionsHandler } from './handlers/completions.js';
import { EmbeddingsHandler } from './handlers/embeddings.js';
import { ModelsHandler } from './handlers/models.js';
import { MessagesHandler } from './handlers/messages.js';
import { ResponsesHandler } from './handlers/responses.js';
import { OpenAIStreamer } from './streaming/openai-streamer.js';
import { AnthropicStreamer } from './streaming/anthropic-streamer.js';
import { ResponsesStreamer } from './streaming/responses-streamer.js';
import { ConfigRequestClassifier, type ConfigClassifierConfig, type ConfigClassificationInput } from '../modules/virtual-router/classifiers/config-request-classifier.js';

export interface ProtocolHandlerConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
  enablePipeline?: boolean;
  pipelineProvider?: {
    defaultProvider: string;
    modelMapping: Record<string, string>;
  };
}

type HandlerMap = {
  chat: ChatCompletionsHandler;
  completions: CompletionsHandler;
  embeddings: EmbeddingsHandler;
  models: ModelsHandler;
  messages: MessagesHandler;
  responses: ResponsesHandler;
};

const DEFAULT_CONFIG: Required<Pick<ProtocolHandlerConfig,
  'enableStreaming' | 'enableMetrics' | 'enableValidation' | 'rateLimitEnabled' | 'authEnabled' | 'timeout' | 'enablePipeline'>> = {
  enableStreaming: true,
  enableMetrics: true,
  enableValidation: true,
  rateLimitEnabled: false,
  authEnabled: false,
  timeout: 30000,
  enablePipeline: false
};

export class ProtocolHandler extends BaseModule {
  private readonly router: Router;
  private readonly serviceContainer: ServiceContainer;
  private readonly handlers: HandlerMap;
  private readonly config: ProtocolHandlerConfig;

  private initialized = false;
  private pipelineManager: unknown = null;
  private routePools: Record<string, string[]> | null = null;
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string }> | null = null;
  private classifierConfig: Record<string, unknown> | null = null;
  private authMappings: Record<string, string> | null = null;
  private classifier: ConfigRequestClassifier | null = null;
  private classifierAdapter: { classify: (payload: unknown) => Promise<unknown> } | null = null;

  constructor(
    _requestHandler: RequestHandler,
    _providerManager: ProviderManager,
    _moduleConfigReader: ModuleConfigReader,
    config: ProtocolHandlerConfig = {}
  ) {
    const moduleInfo: ModuleInfo = {
      id: 'protocol-handler',
      name: 'ProtocolHandler',
      version: '1.0.0',
      description: 'Modular protocol entrypoint',
      type: 'server'
    };

    super(moduleInfo);

    this.router = express.Router();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serviceContainer = ServiceContainer.getInstance();
    initializeDefaultServices(this.serviceContainer);

    this.handlers = {
      chat: new ChatCompletionsHandler(this.config),
      completions: new CompletionsHandler(this.config),
      embeddings: new EmbeddingsHandler(this.config),
      models: new ModelsHandler(this.config),
      messages: new MessagesHandler(this.config),
      responses: new ResponsesHandler(this.config)
    };

    this.registerRoutes();
  }

  public async initialize(): Promise<void> {
    this.initialized = true;
  }

  public getRouter(): Router {
    return this.router;
  }

  public async stop(): Promise<void> {
    this.initialized = false;
  }

  public attachPipelineManager(pipelineManager: unknown): void {
    this.pipelineManager = pipelineManager;
    Object.values(this.handlers).forEach(handler => handler.attachPipelineManager(pipelineManager));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.PIPELINE_MANAGER, pipelineManager);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    Object.values(this.handlers).forEach(handler => handler.attachRoutePools(routePools));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_POOLS, routePools);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta;
    Object.values(this.handlers).forEach(handler => handler.attachRouteMeta(routeMeta));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_META, routeMeta);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRoutingClassifierConfig(classifierConfig: Record<string, unknown>): void {
    this.classifierConfig = classifierConfig;
    try {
      const typedConfig = classifierConfig as unknown as ConfigClassifierConfig;
      this.classifier = new ConfigRequestClassifier(typedConfig);
      this.classifierAdapter = {
        classify: async (payload: unknown) => {
          return this.classifier!.classify(payload as ConfigClassificationInput);
        }
      };
    } catch {
      this.classifier = null;
      this.classifierAdapter = null;
    }

    Object.values(this.handlers).forEach(handler => {
      handler.attachRoutingClassifierConfig(classifierConfig);
      if (this.classifierAdapter) {
        handler.attachRoutingClassifier(this.classifierAdapter);
      }
    });

    if (this.classifierAdapter) {
      try {
        this.serviceContainer.registerInstance(ServiceTokens.ROUTING_CLASSIFIER, this.classifierAdapter);
      } catch { /* ignore duplicate registrations */ }
    }
  }

  public attachAuthMappings(authMappings: Record<string, string>): void {
    this.authMappings = authMappings;
  }

  public async streamFromPipeline(
    response: unknown,
    requestId: string,
    res: Response,
    model?: string,
    protocol: 'openai' | 'anthropic' | 'responses' = 'openai'
  ): Promise<void> {
    const options = { requestId, model: model ?? 'unknown', chunkDelay: 25 };

    // Build synthetic chunk list for non-stream responses
    const makeOpenAIChunks = (resp: any) => {
      const chunks: any[] = [];
      try {
        const content = resp?.choices?.[0]?.message?.content || '';
        if (typeof content === 'string' && content.length > 0) {
          const words = content.split(/\s+/g);
          for (const w of words) {
            chunks.push({ metadata: { model: options.model }, content: w + ' ', done: false });
          }
        }
      } catch { /* ignore */ }
      chunks.push({ metadata: { model: options.model, usage: resp?.usage }, content: '', done: true });
      return chunks;
    };

    const makeAnthropicChunks = (resp: any) => {
      const chunks: any[] = [];
      try {
        const blocks = Array.isArray(resp?.content) ? resp.content : [];
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const words = b.text.split(/\s+/g);
            for (const w of words) {
              chunks.push({ metadata: { model: options.model }, content: w + ' ', done: false });
            }
          }
        }
      } catch { /* ignore */ }
      chunks.push({ metadata: { model: options.model, usage: resp?.usage }, content: '', done: true });
      return chunks;
    };

    if (protocol === 'anthropic') {
      const streamer = new AnthropicStreamer(this.config);
      const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
      const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
        ? resp
        : makeAnthropicChunks(resp);
      await streamer.streamResponse(chunks, options, res);
      return;
    }

    if (protocol === 'responses') {
      const streamer = new ResponsesStreamer(this.config);
      const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
      const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
        ? resp
        : makeOpenAIChunks(resp);
      await streamer.streamResponse(chunks, options, res);
      return;
    }

    const streamer = new OpenAIStreamer(this.config);
    const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
    const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
      ? resp
      : makeOpenAIChunks(resp);
    await streamer.streamResponse(chunks, options, res);
  }

  private registerRoutes(): void {
    this.router.post('/chat/completions', (req: Request, res: Response) => {
      void this.handlers.chat.handleRequest(req, res);
    });

    this.router.post('/completions', (req: Request, res: Response) => {
      void this.handlers.completions.handleRequest(req, res);
    });

    this.router.post('/embeddings', (req: Request, res: Response) => {
      void this.handlers.embeddings.handleRequest(req, res);
    });

    this.router.get('/models', (req: Request, res: Response) => {
      void this.handlers.models.handleRequest(req, res);
    });

    this.router.get('/models/:model', (req: Request, res: Response) => {
      void this.handlers.models.handleRequest(req, res);
    });

    this.router.post('/messages', (req: Request, res: Response) => {
      void this.handlers.messages.handleRequest(req, res);
    });

    this.router.post('/responses', (req: Request, res: Response) => {
      void this.handlers.responses.handleRequest(req, res);
    });
  }
}
