/**
 * RouteCodex Server - Main server implementation
 * Multi-provider OpenAI proxy server
 */

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import path from 'path';
import fs from 'fs';
import { homedir } from 'os';
import type { UnknownObject } from '../types/common-types.js';

interface ErrorContext {
  error: Error | string;
  source: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
  moduleId?: string;
  context?: UnknownObject;
}

/**
 * Server configuration interface
 */
export interface ServerConfig {
  server: {
    port: number;
    host: string;
    cors?: {
      origin: string | string[];
      credentials?: boolean;
    };
    timeout?: number;
    bodyLimit?: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableConsole?: boolean;
    enableFile?: boolean;
    filePath?: string;
    categories?: string[];
    categoryPath?: string;
  };
  providers: Record<string, UnknownObject>;
}

/**
 * RouteCodex Server class
 */
export class RouteCodexServer extends BaseModule {
  private app: Application;
  private server?: unknown;
  private config: ServerConfig;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private logFileStream?: fs.WriteStream;
  private categoryLogStreams: Map<string, fs.WriteStream> = new Map();
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  // Debug enhancement properties
  private serverMetrics: Map<string, UnknownObject> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ServerConfig) {
    const moduleInfo: ModuleInfo = {
      id: 'routecodex-server',
      name: 'RouteCodexServer',
      version: '0.50.1',
      description: 'Multi-provider OpenAI proxy server',
      type: 'server',
    };

    super(moduleInfo);

    this.config = config;
    this.app = express();
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize the server
   */
  public async initialize(): Promise<void> {
    try {
      // Setup logging directory
      this.setupLoggingDirectory();

      // Load module configurations
      this.loadModuleConfigurations();

      // Initialize error handling
      await this.errorHandling.initialize();

      // Setup debug event listener for console logging
      this.setupDebugLogging();

      // Setup Express middleware
      this.setupMiddleware();

      // Setup routes
      this.setupRoutes();

      // Setup error handling
      this.setupErrorHandling();

      this._isInitialized = true;

      // Log initialization
      this.logEvent('server', 'initialized', {
        port: this.config.server.port,
        host: this.config.server.host,
      });
    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Start the server
   */
  public async start(): Promise<void> {
    if (!this._isInitialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.server.port, this.config.server.host, () => {
        this._isRunning = true;
        this.logEvent('server', 'started', {
          port: this.config.server.port,
          host: this.config.server.host,
        });
        resolve();
      });

      (this.server as any).on('error', async (error: Error) => {
        await this.handleError(error, 'server_start');
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  public async stop(): Promise<void> {
    if (this.server) {
      return new Promise(resolve => {
        (this.server as any)?.close(async () => {
          this._isRunning = false;
          this.logEvent('server', 'stopped', {});

          // Cleanup modules
          await this.errorHandling.destroy();

          // Close log file stream
          if (this.logFileStream) {
            this.logFileStream.end();
            console.log('Log file stream closed');
          }

          // Close category log file streams
          this.categoryLogStreams.forEach((stream, category) => {
            stream.end();
            console.log(`Category log file stream closed for: ${category}`);
          });
          this.categoryLogStreams.clear();

          resolve();
        });
      });
    }
  }

  /**
   * Get server status
   */
  public getStatus() {
    return {
      initialized: this._isInitialized,
      running: this._isRunning,
      port: this.config.server.port,
      host: this.config.server.host,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }

  /**
   * Override BaseModule methods
   */
  public isInitialized(): boolean {
    return this._isInitialized;
  }

  public isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Setup logging directory and file stream
   */
  private setupLoggingDirectory(): void {
    if (this.config.logging.enableFile && this.config.logging.filePath) {
      // Resolve ~ to home directory
      let logPath = this.config.logging.filePath;
      if (logPath.startsWith('~')) {
        logPath = path.join(homedir(), logPath.substring(1));
      }

      // Create main log directory if it doesn't exist
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
        console.log(`Created logging directory: ${logDir}`);
      }

      // Create category subdirectories
      const categories = this.config.logging.categories || [
        'server',
        'api',
        'request',
        'config',
        'error',
        'message',
      ];
      const categoryPath = this.config.logging.categoryPath || logDir;

      categories.forEach(category => {
        const categoryDir = path.join(categoryPath, category);
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
          console.log(`Created category logging directory: ${categoryDir}`);
        }

        // Create category-specific log file stream
        const categoryLogPath = path.join(categoryDir, `${category}.log`);
        const categoryStream = fs.createWriteStream(categoryLogPath, { flags: 'a' });
        categoryStream.on('error', error => {
          console.error(`Category log file stream error for ${category}:`, error);
        });
        this.categoryLogStreams.set(category, categoryStream);
      });

      // Create main log file write stream
      this.logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.logFileStream.on('error', error => {
        console.error('Main log file stream error:', error);
      });

      console.log(`Logging configured for file: ${logPath}`);
      console.log(`Category logging enabled for: ${categories.join(', ')}`);
      console.log(`Category log directory: ${categoryPath}`);
    }
  }

  /**
   * Load module configurations
   */
  private loadModuleConfigurations(): void {
    // Use import.meta.url to get the current file's directory
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const moduleConfigPath = path.join(currentDir, '..', '..', 'config', 'modules.json');

    if (fs.existsSync(moduleConfigPath)) {
      try {
        const moduleConfig = JSON.parse(fs.readFileSync(moduleConfigPath, 'utf8'));
        console.log('Module configurations loaded successfully');

        // Log each module's configuration status
        if (moduleConfig.modules) {
          Object.entries(moduleConfig.modules).forEach(([moduleName, config]: [string, unknown]) => {
            const configObj = config as UnknownObject;
            console.log(`[CONFIG] ${moduleName}: ${configObj.enabled ? 'enabled' : 'disabled'}`);
            if (configObj.enabled && configObj.config) {
              console.log(`[CONFIG] ${moduleName} settings:`, Object.keys(configObj.config));
            }
          });
        }

        this.logEvent('config', 'modules_loaded', {
          modules: Object.keys(moduleConfig.modules || {}),
          configPath: moduleConfigPath,
        });
      } catch (error) {
        console.error('Failed to load module configurations:', error);
        this.logEvent('config', 'modules_load_failed', {
          error: error instanceof Error ? error.message : String(error),
          configPath: moduleConfigPath,
        });
      }
    } else {
      console.log('Module configuration file not found, using defaults');
      this.logEvent('config', 'modules_not_found', {
        configPath: moduleConfigPath,
      });
    }
  }

  /**
   * Write to category-specific log file
   */
  private writeToCategoryLog(category: string, message: string): void {
    const categoryStream = this.categoryLogStreams.get(category);
    if (categoryStream) {
      categoryStream.write(message);
    }
  }

  /**
   * Setup debug logging
   */
  private setupDebugLogging(): void {
    // Subscribe to all debug events
    this.debugEventBus.subscribe('*', (event: UnknownObject) => {
      if (this.config.logging.level === 'debug') {
        const timestamp = new Date(event.timestamp as any).toISOString();
        const eventData = event.data as Record<string, unknown>;
        const category = (eventData?.category as string) || 'general';
        const action = (eventData?.action as string) || 'unknown';

        const logMessage = `[${timestamp}] [DEBUG] ${event.operationId}: ${JSON.stringify(
          {
            category,
            action,
            moduleId: event.moduleId,
            data: event.data,
          },
          null,
          2
        )}\n`;

        // Log to console
        console.log(`[DEBUG] ${event.operationId}:`, {
          category,
          action,
          timestamp,
          moduleId: event.moduleId,
          data: event.data,
        });

        // Log to main file
        if (this.logFileStream) {
          this.logFileStream.write(logMessage);
        }

        // Log to category-specific file
        this.writeToCategoryLog(category, logMessage);
      }
    });

    // Log debug center setup
    console.log('Debug logging enabled for event:', '*');
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Security middleware
    this.app.use(helmet());

    // CORS middleware
    if (this.config.server.cors) {
      this.app.use(cors(this.config.server.cors));
    } else {
      this.app.use(
        cors({
          origin: '*',
          credentials: true,
        })
      );
    }

    // Body parsing middleware
    this.app.use(express.json({ limit: this.config.server.bodyLimit || '10mb' }));
    this.app.use(
      express.urlencoded({ extended: true, limit: this.config.server.bodyLimit || '10mb' })
    );

    // Request logging middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logEvent('request', 'completed', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: duration,
          userAgent: req.get('user-agent'),
          ip: req.ip,
        });
      });

      next();
    });
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      const status = this.getStatus();
      res.json({
        status: status.running ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: status.uptime,
        memory: status.memory,
        version: this.getModuleInfo().version,
      });
    });

    // OpenAI-compatible endpoints
    this.app.post('/v1/chat/completions', this.handleChatCompletions.bind(this));
    this.app.post('/v1/completions', this.handleCompletions.bind(this));
    this.app.get('/v1/models', this.handleModels.bind(this));

    // Status endpoint
    this.app.get('/status', (req: Request, res: Response) => {
      res.json(this.getStatus());
    });

    // Test error endpoint
    this.app.get('/test-error', async (req: Request, res: Response) => {
      try {
        // Simulate an error that should be handled by error handling center
        const testError = new Error('This is a test error for error handling validation');
        await this.handleError(testError, 'test_error_endpoint');

        res.json({
          message: 'Test error processed successfully',
          error: testError.message,
        });
      } catch (error) {
        res.status(500).json({
          error: {
            message: 'Failed to process test error',
            type: 'test_error_failed',
          },
        });
      }
    });

    // 404 handler
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: 'Not Found',
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
    this.app.use((error: UnknownObject, req: Request, res: Response, _next: NextFunction) => {
      this.handleError(error as unknown as Error, 'request_handler').catch(() => {
        // Ignore handler errors, just send response
      });

      const errorStatus = (error as any).status || 500;
      res.status(errorStatus).json({
        error: {
          message: (error as any).message || 'Internal Server Error',
          type: (error as any).type || 'internal_error',
          code: error.code || 'internal_error',
        },
      });
    });
  }

  /**
   * Handle chat completions
   */
  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    try {
      this.logEvent('api', 'chat_completions_request', {
        model: req.body.model,
        messages: req.body.messages?.length || 0,
      });

      // Provider routing not yet implemented - return proper error
      res.status(501).json({
        error: {
          message: 'Provider routing not yet implemented',
          type: 'not_implemented',
          code: 'provider_routing_not_implemented',
        },
      });
      return;
    } catch (error) {
      await this.handleError(error as Error, 'chat_completions_handler');
      throw error;
    }
  }

  /**
   * Handle completions
   */
  private async handleCompletions(req: Request, res: Response): Promise<void> {
    try {
      this.logEvent('api', 'completions_request', {
        model: req.body.model,
        prompt: req.body.prompt?.length || 0,
      });

      // Provider routing not yet implemented - return proper error
      res.status(501).json({
        error: {
          message: 'Provider routing not yet implemented',
          type: 'not_implemented',
          code: 'provider_routing_not_implemented',
        },
      });
      return;
    } catch (error) {
      await this.handleError(error as Error, 'completions_handler');
      throw error;
    }
  }

  /**
   * Handle models list
   */
  private async handleModels(req: Request, res: Response): Promise<void> {
    try {
      this.logEvent('api', 'models_request', {});

      // Return available models from configured providers
      const models = [];

      for (const [providerId, providerConfig] of Object.entries(this.config.providers)) {
        if (providerConfig.enabled && providerConfig.models) {
          for (const [modelId, _modelConfig] of Object.entries(providerConfig.models)) { // eslint-disable-line @typescript-eslint/no-unused-vars
            models.push({
              id: modelId,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: providerId,
            });
          }
        }
      }

      res.json({
        object: 'list',
        data: models,
      });
    } catch (error) {
      await this.handleError(error as Error, 'models_handler');
      throw error;
    }
  }

  /**
   * Log event to debug center
   */
  private logEvent(category: string, action: string, data: UnknownObject): void {
    try {
      // Also log to category-specific file directly
      if (this.config.logging.enableFile) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [EVENT] ${category}_${action}: ${JSON.stringify(
          {
            category,
            action,
            ...data,
          },
          null,
          2
        )}\n`;

        this.writeToCategoryLog(category, logMessage);
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: `${category}_${action}`,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          category,
          action,
          ...data,
        },
      });
    } catch (error) {
      // Don't let logging errors break the server
      console.error('Failed to log event:', error);
    }
  }

  /**
   * Handle error with error handling center
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `${this.getModuleInfo().id}.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: this.getModuleInfo().id,
        context: {
          stack: error.stack,
          name: error.name,
        },
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Get module info
   */
  public getModuleInfo(): ModuleInfo {
    return {
      id: 'routecodex-server',
      name: 'RouteCodexServer',
      version: '0.0.1',
      description: 'Multi-provider OpenAI proxy server',
      type: 'server',
    };
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      console.log('RouteCodexServer debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize RouteCodexServer debug enhancements:', error);
    }
  }

  /**
   * Record server metric
   */
  private recordServerMetric(operation: string, data: UnknownObject): void {
    if (!this.serverMetrics.has(operation)) {
      this.serverMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now(),
      });
    }

    const metric = this.serverMetrics.get(operation)! as any;
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
  private addToRequestHistory(operation: UnknownObject): void {
    this.requestHistory.push(operation);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(operation: UnknownObject): void {
    this.errorHistory.push(operation);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): UnknownObject {
    const baseStatus = {
      serverId: this.getModuleInfo().id,
      name: this.getModuleInfo().name,
      version: this.getModuleInfo().version,
      isInitialized: this._isInitialized,
      isRunning: this._isRunning,
      config: this.config.server,
      isEnhanced: true,
    };

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      serverMetrics: this.getServerMetrics(),
      requestHistory: [...this.requestHistory.slice(-10)],
      errorHistory: [...this.errorHistory.slice(-10)],
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): UnknownObject {
    return {
      serverId: this.getModuleInfo().id,
      name: this.getModuleInfo().name,
      version: this.getModuleInfo().version,
      enhanced: true,
      uptime: this._isRunning ? process.uptime() : 0,
      memory: process.memoryUsage(),
      requestHistorySize: this.requestHistory.length,
      errorHistorySize: this.errorHistory.length,
      serverMetricsSize: this.serverMetrics.size,
      maxHistorySize: this.maxHistorySize,
      categoryLogStreams: this.categoryLogStreams.size,
      hasLogFile: !!this.logFileStream,
    };
  }

  /**
   * Get server metrics
   */
  private getServerMetrics(): UnknownObject {
    const metrics: UnknownObject = {};

    for (const [operation, metric] of this.serverMetrics.entries()) {
      const metricObj = metric as any;
      metrics[operation] = {
        count: metricObj.values.length,
        lastUpdated: metricObj.lastUpdated,
        recentValues: metricObj.values.slice(-5),
      };
    }

    return metrics;
  }
}
