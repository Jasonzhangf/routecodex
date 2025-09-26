/**
 * HTTP Server Implementation
 * Express.js-based HTTP server with middleware setup, health checks, and error handling
 */

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingUtils } from '../utils/error-handling-utils.js';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import { isSimpleLogEnabled, getSimpleLogConfig } from '../logging/simple-log-integration.js';
import { OpenAIRouter } from './openai-router.js';
import { RequestHandler } from '../core/request-handler.js';
import { ProviderManager } from '../core/provider-manager.js';
import { PipelineManager } from '../modules/pipeline/core/pipeline-manager.js';
import {
  type ServerConfig,
  type HealthStatus,
  type ProviderHealth,
  type IHttpServer,
  type ServerModuleInfo,
} from './types.js';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { DebugFileLogger } from '../debug/debug-file-logger.js';

/**
 * HTTP Server configuration interface
 */
export interface HttpServerConfig {
  port: number;
  host: string;
  cors?: {
    origin: string | string[];
    credentials?: boolean;
  };
  timeout?: number;
  bodyLimit?: string;
  enableMetrics?: boolean;
  enableHealthChecks?: boolean;
}

/**
 * HTTP Server class
 */
export class HttpServer extends BaseModule implements IHttpServer {
  private app: Application;
  private server?: any;
  private moduleConfigReader: ModuleConfigReader;
  private openaiRouter: OpenAIRouter;
  private requestHandler: RequestHandler;
  private providerManager: ProviderManager;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;
  private healthStatus: HealthStatus;
  private startupTime: number;
  private config: any;
  private mergedConfig: any | null = null;
  private pipelineManager: PipelineManager | null = null;
  private routePools: Record<string, string[]> | null = null;

  // Debug enhancement properties
  private isDebugEnhanced = false;
  private serverMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 100;

  /** Generate a session id that embeds the current port for DebugCenter port-level separation */
  private async sessionId(tag: string): Promise<string> {
    try {
      const cfg = await this.getServerConfig();
      return `p${cfg.server.port}_${tag}_${Date.now()}`;
    } catch {
      return `p_unknown_${tag}_${Date.now()}`;
    }
  }

  constructor(modulesConfigPath: string = './config/modules.json') {
    const moduleInfo: ModuleInfo = {
      id: 'http-server',
      name: 'HttpServer',
      version: '0.0.1',
      description: 'Express.js HTTP server for RouteCodex',
      type: 'server',
    };

    super(moduleInfo);

    // Store module info for debug access
    const moduleInfoForDebug = moduleInfo;
    (this as any).moduleInfo = moduleInfoForDebug;

    this.moduleConfigReader = new ModuleConfigReader(modulesConfigPath);
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('http-server');
    this.app = express();
    this.startupTime = Date.now();

    // Initialize health status
    this.healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: 0,
      memory: process.memoryUsage(),
      providers: {},
    };

    // Initialize components with default configuration - will be properly initialized in initialize() method
    this.providerManager = new ProviderManager(this.getDefaultServerConfig());
    this.requestHandler = new RequestHandler(this.providerManager, this.getDefaultServerConfig());
    this.openaiRouter = new OpenAIRouter(
      this.requestHandler,
      this.providerManager,
      this.moduleConfigReader
    );

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Get default server configuration for initialization
   */
  private getDefaultServerConfig(): ServerConfig {
    // 检查简化日志配置
    const simpleLogConfig = getSimpleLogConfig();
    let loggingConfig = {
      level: 'info' as any,
      enableConsole: true,
      enableFile: false,
      categories: ['server', 'api', 'request', 'config', 'error', 'message'],
    };

    if (simpleLogConfig && simpleLogConfig.enabled) {
      console.log('📋 检测到简化日志配置，正在应用到服务器...');
      loggingConfig = {
        level: simpleLogConfig.logLevel as any,
        enableConsole: simpleLogConfig.output === 'console' || simpleLogConfig.output === 'both',
        enableFile: simpleLogConfig.output === 'file' || simpleLogConfig.output === 'both',
        categories: ['server', 'api', 'request', 'config', 'error', 'message'],
      };

      if (loggingConfig.enableFile) {
        console.log(`📁 日志将保存到: ${simpleLogConfig.logDirectory}`);
      }
    }

    return {
      server: {
        port: 5506,
        host: 'localhost',
        cors: {
          origin: '*',
          credentials: true,
        },
        timeout: 30000,
        bodyLimit: '10mb',
      },
      logging: loggingConfig,
      providers: {},
      routing: {
        strategy: 'round-robin',
        timeout: 30000,
        retryAttempts: 3,
      },
    };
  }

  /**
   * Get server configuration from modules config
   */
  private async getServerConfig(): Promise<ServerConfig> {
    // Require merged configuration injected via initializeWithMergedConfig
    if (!this.config) {
      throw new Error('Server configuration missing. Ensure merged-config is initialized.');
    }
    const cfg: any = this.config as any;
    if (typeof cfg.port !== 'number' || cfg.port <= 0) {
      throw new Error(
        'HTTP server port is missing. Please set httpserver.port in your user config (~/.routecodex/config.json).'
      );
    }
    const logging = cfg.logging || {};
    return {
      server: {
        port: cfg.port,
        host: cfg.host || 'localhost',
        cors: cfg.cors || { origin: '*', credentials: true },
        timeout: cfg.timeout || 30000,
        bodyLimit: cfg.bodyLimit || '10mb',
      },
      logging: {
        level: logging.level || 'info',
        enableConsole: logging.enableConsole !== false,
        enableFile: logging.enableFile === true,
        filePath: logging.filePath,
        categories: logging.categories || [
          'server',
          'api',
          'request',
          'config',
          'error',
          'message',
        ],
      },
      providers: {},
      routing: {
        strategy: 'round-robin',
        timeout: 30000,
        retryAttempts: 3,
      },
    };
  }

  /**
   * Initialize the HTTP server with merged configuration
   */
  public async initializeWithMergedConfig(mergedConfig: any): Promise<void> {
    try {
      console.log('🔄 Initializing HTTP server with merged configuration...');

      // Set up the server with merged configuration
      this.mergedConfig = mergedConfig;
      this.config = mergedConfig.modules?.httpserver?.config || this.getDefaultServerConfig();

      // Initialize DebugCenter file logging if configured
      const debugCenterConfig = mergedConfig.modules?.debugcenter?.config;
      if (debugCenterConfig?.enableFile && debugCenterConfig.filePath) {
        DebugFileLogger.initialize({
          filePath: debugCenterConfig.filePath,
          enabled: true,
        });
      }

      // Continue with normal initialization
      await this.initialize();

      console.log('✅ HTTP server initialized with merged configuration successfully');
    } catch (error) {
      console.error('❌ Failed to initialize HTTP server with merged configuration:', error);
      throw error;
    }
  }

  /**
   * Initialize the HTTP server
   */
  public async initialize(): Promise<void> {
    try {
      // Load modules configuration
      await this.moduleConfigReader.load();

      // Initialize error handling utilities
      await ErrorHandlingUtils.initialize();

      // Initialize error handling
      await this.errorHandling.initialize();

      // Re-initialize components with actual configuration
      const serverConfig = await this.getServerConfig();
      this.providerManager = new ProviderManager(serverConfig);
      this.requestHandler = new RequestHandler(this.providerManager, serverConfig);
      // Load router config from modules.json if available
      const openaiRouterModule = this.moduleConfigReader.getModuleConfigValue<any>(
        'openairouter',
        {}
      );
      this.openaiRouter = new OpenAIRouter(
        this.requestHandler,
        this.providerManager,
        this.moduleConfigReader,
        (openaiRouterModule || {}) as any
      );

      // Initialize request handler
      await this.requestHandler.initialize();

      // Initialize provider manager
      await this.providerManager.initialize();

      // Initialize OpenAI router
      await this.openaiRouter.initialize();

      // Optionally initialize PipelineManager (LM Studio pipeline)
      await this.initializePipelineIfConfigured();

      // Setup Express middleware
      await this.setupMiddleware();

      // Setup routes
      this.setupRoutes();

      // Setup error handling
      this.setupErrorHandling();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      // Register error messages for HTTP server
      this.errorUtils.registerMessage(
        'server_start_error',
        'Failed to start HTTP server',
        'critical',
        'server',
        'HTTP server failed to start on specified port',
        'Check port availability and permissions'
      );

      this.errorUtils.registerMessage(
        'server_stop_error',
        'Failed to stop HTTP server',
        'high',
        'server',
        'HTTP server failed to stop gracefully',
        'Force kill process and check for resource leaks'
      );

      this.errorUtils.registerMessage(
        'middleware_error',
        'Express middleware error',
        'medium',
        'server',
        'Error in Express middleware setup',
        'Check middleware configuration and dependencies'
      );

      this.errorUtils.registerMessage(
        'route_error',
        'Route handling error',
        'medium',
        'server',
        'Error processing HTTP route',
        'Check route configuration and request format'
      );

      this.errorUtils.registerMessage(
        'initialization_error',
        'Server initialization error',
        'critical',
        'system',
        'Failed to initialize server components',
        'Check logs and ensure all dependencies are available'
      );

      // Register error handlers for HTTP server
      this.errorUtils.registerHandler(
        'server_start_error',
        async context => {
          console.error(`Server start error: ${context.error}`);
          // Could implement automatic port change or retry logic
        },
        1,
        'Handle server startup errors'
      );

      this.errorUtils.registerHandler(
        'initialization_error',
        async context => {
          console.error(`Critical initialization error: ${context.error}`);
          // Could implement component restart logic
        },
        0,
        'Handle critical initialization errors'
      );

      this._isInitialized = true;

      this.debugEventBus.publish({
        sessionId: await this.sessionId('http_server_initialized'),
        moduleId: 'http-server',
        operationId: 'http_server_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          configPath: './config/modules.json',
          port: (await this.getServerConfig()).server.port,
          host: (await this.getServerConfig()).server.host,
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Backward-compatible no-op: pipeline initialization is externally assembled now.
   * Kept to satisfy older call sites without breaking the server lifecycle.
   */
  private async initializePipelineIfConfigured(): Promise<void> {
    // Intentionally left blank. Pipeline assembly happens via merged-config assembler.
    return;
  }

  /**
   * Attach a pipeline manager to the OpenAI router (enables HTTP → Router → Pipeline layering)
   */
  public attachPipelineManager(pipelineManager: any): void {
    try {
      if (this.openaiRouter && (this.openaiRouter as any).attachPipelineManager) {
        (this.openaiRouter as any).attachPipelineManager(pipelineManager);
      }
    } catch (error) {
      // Do not break server if attachment fails
      console.error('Failed to attach pipeline manager to OpenAI router:', error);
    }
  }

  /** Attach static route pools for round-robin dispatch */
  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    try {
      if (this.openaiRouter && (this.openaiRouter as any).attachRoutePools) {
        (this.openaiRouter as any).attachRoutePools(routePools);
      }
    } catch (error) {
      console.error('Failed to attach route pools to OpenAI router:', error);
    }
  }

  /** Attach classification config to router */
  public attachRoutingClassifierConfig(classifierConfig: any): void {
    try {
      if (this.openaiRouter && (this.openaiRouter as any).attachRoutingClassifierConfig) {
        (this.openaiRouter as any).attachRoutingClassifierConfig(classifierConfig);
      }
    } catch (error) {
      console.error('Failed to attach routing classifier config to OpenAI router:', error);
    }
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.isDebugEnhanced = true;
      console.log('HTTP Server debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize HTTP Server debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Record server metric
   */
  private recordServerMetric(operation: string, data: any): void {
    if (!this.serverMetrics.has(operation)) {
      this.serverMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now(),
      });
    }

    const metric = this.serverMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to request history
   */
  private addToRequestHistory(request: any): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: any): void {
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced) {
      return;
    }

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'http-server',
        operationId: type,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          ...data,
          serverId: (this as any).moduleInfo.id,
          source: 'http-server',
        },
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const moduleInfo = (this as any).moduleInfo;
    const baseStatus = {
      serverId: moduleInfo.id,
      isInitialized: this._isInitialized,
      isRunning: this._isRunning,
      type: moduleInfo.type,
      isEnhanced: this.isDebugEnhanced,
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      serverMetrics: this.getServerMetrics(),
      healthStatus: this.healthStatus,
      requestHistory: [...this.requestHistory.slice(-10)], // Last 10 requests
      errorHistory: [...this.errorHistory.slice(-10)], // Last 10 errors
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): any {
    const moduleInfo = (this as any).moduleInfo;
    return {
      serverId: moduleInfo.id,
      serverType: moduleInfo.type,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      requestHistorySize: this.requestHistory.length,
      errorHistorySize: this.errorHistory.length,
      uptime: Date.now() - this.startupTime,
      hasPipelineManager: !!this.pipelineManager,
      hasRoutePools: !!this.routePools,
      serverConfig: this.config?.server || null,
    };
  }

  /**
   * Get server metrics
   */
  private getServerMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.serverMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5), // Last 5 values
      };
    }

    return metrics;
  }

  // Pipeline assembly removed: handled externally via merged-config assembler.

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    if (!this._isInitialized) {
      await this.initialize();
    }

    const config = await this.getServerConfig();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(config.server.port, config.server.host, () => {
        this._isRunning = true;
        this.startupTime = Date.now();

        this.debugEventBus.publish({
          sessionId: `p${config.server.port}_http_server_started_${Date.now()}`,
          moduleId: 'http-server',
          operationId: 'http_server_started',
          timestamp: Date.now(),
          type: 'start',
          position: 'middle',
          data: {
            port: config.server.port,
            host: config.server.host,
            uptime: this.getUptime(),
          },
        });

        console.log(
          `🚀 RouteCodex HTTP Server started on http://${config.server.host}:${config.server.port}`
        );
        resolve();
      });

      this.server.on('error', async (error: any) => {
        await this.handleError(error, 'server_start');
        reject(error);
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    try {
      if (this.server) {
        return new Promise(resolve => {
          this.server.close(async () => {
            this._isRunning = false;

            // Stop all components
            await this.openaiRouter.stop();
            await this.providerManager.stop();
            await this.requestHandler.stop();
            // Config manager doesn't need to be closed in new architecture
            await this.errorHandling.destroy();

            this.debugEventBus.publish({
              sessionId: `session_${Date.now()}`,
              moduleId: 'http-server',
              operationId: 'http_server_stopped',
              timestamp: Date.now(),
              type: 'end',
              position: 'middle',
              data: {
                uptime: this.getUptime(),
              },
            });

            console.log('🛑 RouteCodex HTTP Server stopped');
            resolve();
          });
        });
      }
    } catch (error) {
      await this.handleError(error as Error, 'server_stop');
      throw error;
    }
  }

  /**
   * Get current health status
   */
  public getStatus(): HealthStatus {
    const config = this.getDefaultServerConfig();

    return {
      status: this._isRunning ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      memory: process.memoryUsage(),
      providers: this.providerManager.getAllProvidersHealth(),
    };
  }

  /**
   * Get module info
   */
  public getModuleInfo(): ServerModuleInfo {
    return {
      id: 'http-server',
      name: 'HttpServer',
      version: '0.0.1',
      description: 'Express.js HTTP server for RouteCodex',
      type: 'server',
      capabilities: ['http-server', 'openai-api', 'health-checks', 'metrics'],
      dependencies: ['config-manager', 'request-handler', 'provider-manager', 'openai-router'],
    };
  }

  /**
   * Setup Express middleware
   */
  private async setupMiddleware(): Promise<void> {
    const config = await this.getServerConfig();

    // Security middleware
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
          },
        },
      })
    );

    // CORS middleware
    if (config.server.cors) {
      this.app.use(cors(config.server.cors));
    } else {
      this.app.use(
        cors({
          origin: '*',
          credentials: true,
        })
      );
    }

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - start;

        this.debugEventBus.publish({
          sessionId: `session_${Date.now()}`,
          moduleId: 'http-server',
          operationId: 'request_completed',
          timestamp: Date.now(),
          type: 'end',
          position: 'middle',
          data: {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration,
            userAgent: req.get('user-agent'),
            ip: req.ip,
          },
        });
      });

      next();
    });

    // Request timeout middleware
    if (config.server.timeout) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        req.setTimeout(config.server.timeout!);
        next();
      });
    }

    // Compression middleware (if needed)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Powered-By', 'RouteCodex');
      next();
    });
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // Health check endpoints
    this.app.get('/health', this.handleHealthCheck.bind(this));
    this.app.get('/healthz', this.handleHealthCheck.bind(this));
    this.app.get('/ready', this.handleReadinessCheck.bind(this));
    this.app.get('/live', this.handleLivenessCheck.bind(this));

    // Metrics endpoint
    this.app.get('/metrics', async (req, res) => this.handleMetrics(req, res));

    // OpenAI API endpoints (mounted at /v1/openai)
    this.app.use('/v1/openai', this.openaiRouter.getRouter());

    // Anthropic API endpoints (placeholder for future implementation)
    this.app.use('/v1/anthropic', (req: Request, res: Response) => {
      res.status(501).json({
        error: {
          message: 'Anthropic API endpoints not yet implemented',
          type: 'not_implemented_error',
          code: 'anthropic_not_implemented',
        },
      });
    });

    // Status endpoint
    this.app.get('/status', this.handleStatus.bind(this));

    // Configuration endpoint
    this.app.get('/config', async (req, res) => this.handleConfig(req, res));

    // Merged configuration endpoint (raw merged-config for current instance)
    this.app.get('/merged-config', async (_req: Request, res: Response) => {
      try {
        const merged = this.mergedConfig || null;
        res.status(200).json({
          mergedConfig: merged,
          note: 'This is the in-memory merged configuration for this server instance.',
        });
      } catch (err) {
        res.status(500).json({
          error: { message: err instanceof Error ? err.message : 'Failed to read merged config' },
        });
      }
    });

    // Debug endpoint
    this.app.get('/debug', this.handleDebug.bind(this));

    // Test endpoint for error handling
    this.app.get('/test-error', this.handleTestError.bind(this));

    // Root endpoint
    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        name: 'RouteCodex',
        version: this.getModuleInfo().version,
        description: 'Multi-provider AI API proxy server',
        status: this.getStatus(),
        endpoints: {
          health: '/health',
          metrics: '/metrics',
          status: '/status',
          openai: '/v1/openai/*',
          anthropic: '/v1/anthropic/*',
          config: '/config',
        },
      });
    });

    // 404 handler
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: `Route ${req.method} ${req.originalUrl} not found`,
          type: 'not_found_error',
          code: 'not_found',
        },
      });
    });
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.app.use(async (error: any, req: Request, res: Response, next: NextFunction) => {
      // Friendly JSON parse error mapping
      if (error?.type === 'entity.parse.failed') {
        res.status(400).json({
          error: {
            message: `Invalid JSON body: ${error?.message || 'parse failed'}`,
            type: 'bad_request',
            code: 'invalid_json',
          },
        });
        return;
      }

      await this.handleError(error, 'request_handler');

      const status = error.status || 500;
      const message = error.message || 'Internal Server Error';

      res.status(status).json({
        error: {
          message,
          type: error.type || 'internal_error',
          code: error.code || 'internal_error',
          ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
        },
      });
    });
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`🛑 Received ${signal}, shutting down gracefully...`);

      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', async error => {
      console.error('Uncaught Exception:', error);
      await this.handleError(error, 'uncaught_exception');
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', async (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      await this.handleError(
        reason instanceof Error ? reason : new Error(String(reason)),
        'unhandled_rejection'
      );
      process.exit(1);
    });
  }

  /**
   * Handle health check
   */
  private handleHealthCheck(req: Request, res: Response): void {
    const status = this.getStatus();

    // Update health status
    this.healthStatus = {
      status: status.status,
      timestamp: new Date().toISOString(),
      uptime: status.uptime,
      memory: status.memory,
      providers: status.providers,
    };

    const httpStatus = status.status === 'healthy' ? 200 : 503;

    res.status(httpStatus).json({
      status: status.status,
      timestamp: this.healthStatus.timestamp,
      uptime: status.uptime,
      memory: status.memory,
      version: this.getModuleInfo().version,
      providers: status.providers,
    });
  }

  /**
   * Handle readiness check
   */
  private handleReadinessCheck(req: Request, res: Response): void {
    const isReady = this._isInitialized && this._isRunning;
    const status = isReady ? 'ready' : 'not_ready';

    res.status(isReady ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        initialized: this._isInitialized,
        running: this._isRunning,
        providers: this.providerManager.getAllProvidersHealth(),
      },
    });
  }

  /**
   * Handle liveness check
   */
  private handleLivenessCheck(req: Request, res: Response): void {
    const isAlive = this._isRunning;

    res.status(isAlive ? 200 : 503).json({
      status: isAlive ? 'alive' : 'not_alive',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
    });
  }

  /**
   * Handle metrics
   */
  private async handleMetrics(req: Request, res: Response): Promise<void> {
    const config = await this.getServerConfig();
    const metrics = {
      server: {
        uptime: this.getUptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        version: this.getModuleInfo().version,
        node_version: process.version,
      },
      requests: {
        // Add request metrics here if needed
      },
      providers: this.providerManager.getMetrics(),
      config: {
        provider_count: Object.keys(config.providers).length,
        enabled_providers: Object.values(config.providers).filter((p: any) => p.enabled).length,
      },
    };

    res.json(metrics);
  }

  /**
   * Handle status
   */
  private handleStatus(req: Request, res: Response): void {
    res.json(this.getStatus());
  }

  /**
   * Handle configuration
   */
  private async handleConfig(req: Request, res: Response): Promise<void> {
    const config = await this.getServerConfig();

    // Return sanitized configuration (without sensitive data)
    const sanitizedConfig = {
      server: config.server,
      logging: config.logging,
      routing: config.routing,
      providers: Object.keys(config.providers).reduce((acc: any, key: string) => {
        acc[key] = {
          type: config.providers[key].type,
          enabled: config.providers[key].enabled,
          models: Object.keys(config.providers[key].models || {}),
        };
        return acc;
      }, {}),
    };

    res.json(sanitizedConfig);
  }

  /**
   * Handle debug information
   */
  private handleDebug(req: Request, res: Response): void {
    if (process.env.NODE_ENV !== 'development') {
      res.status(403).json({
        error: {
          message: 'Debug endpoint only available in development mode',
          type: 'forbidden_error',
          code: 'debug_forbidden',
        },
      });
      return;
    }

    const debugInfo = {
      server: this.getStatus(),
      modules: {
        httpserver: {
          id: 'http-server',
          name: 'HTTP Server',
          version: '1.0.0',
          status: this.getStatus(),
        },
        requestHandler: this.requestHandler.getModuleInfo(),
        providerManager: this.providerManager.getInfo(),
        openaiRouter: this.openaiRouter.getModuleInfo(),
      },
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        memory_usage: process.memoryUsage(),
        uptime: process.uptime(),
      },
      configuration: this.getServerConfig(),
    };

    res.json(debugInfo);
  }

  /**
   * Handle test error
   */
  private async handleTestError(req: Request, res: Response): Promise<void> {
    try {
      // Simulate an error for testing
      const testError = new Error('This is a test error for error handling validation');
      await this.handleError(testError, 'test_error_endpoint');

      res.json({
        message: 'Test error processed successfully',
        error: testError.message,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message: 'Failed to process test error',
          type: 'test_error_failed',
        },
      });
    }
  }

  /**
   * Get server uptime
   */
  private getUptime(): number {
    return this._isRunning ? Math.floor((Date.now() - this.startupTime) / 1000) : 0;
  }

  /**
   * Handle error with enhanced error handling system
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      // Use enhanced error handling utilities
      await this.errorUtils.handle(error, context, {
        severity: this.getErrorSeverity(context),
        category: this.getErrorCategory(context),
        additionalContext: {
          uptime: this.getUptime(),
          memory: process.memoryUsage(),
          isRunning: this._isRunning,
          isInitialized: this._isInitialized,
        },
      });
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Get error severity based on context
   */
  private getErrorSeverity(context: string): 'low' | 'medium' | 'high' | 'critical' {
    const criticalContexts = [
      'initialization',
      'server_start',
      'server_stop',
      'uncaught_exception',
      'unhandled_rejection',
    ];
    const highContexts = ['configuration', 'provider_health', 'memory'];
    const mediumContexts = ['request_handler', 'middleware', 'route'];

    if (criticalContexts.some(c => context.includes(c))) {
      return 'critical';
    }
    if (highContexts.some(c => context.includes(c))) {
      return 'high';
    }
    if (mediumContexts.some(c => context.includes(c))) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Get error category based on context
   */
  private getErrorCategory(context: string): string {
    const categories: Record<string, string> = {
      initialization: 'system',
      server_start: 'server',
      server_stop: 'server',
      request_handler: 'request',
      middleware: 'server',
      route: 'request',
      configuration: 'configuration',
      provider_health: 'provider',
      memory: 'system',
      uncaught_exception: 'system',
      unhandled_rejection: 'system',
    };

    for (const [key, category] of Object.entries(categories)) {
      if (context.includes(key)) {
        return category;
      }
    }
    return 'general';
  }
}
