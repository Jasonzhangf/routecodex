/**
 * HTTP Server Implementation
 * Express.js-based HTTP server with middleware setup, health checks, and error handling
 */

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import fs from 'fs/promises';
import cors from 'cors';
import helmet from 'helmet';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingUtils } from '../utils/error-handling-utils.js';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import { ProtocolHandler } from './protocol-handler.js';
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
import type { UnknownObject } from '../types/common-types.js';
import { DebugFileLogger } from '../debug/debug-file-logger.js';
import { ConfigRequestClassifier } from '../modules/virtual-router/classifiers/config-request-classifier.js';
import { ServiceContainer, ServiceTokens } from './core/service-container.js';

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
  private server?: unknown;
  private servers: unknown[] = [];
  private moduleConfigReader: ModuleConfigReader;
  private protocolHandler: ProtocolHandler;
  private requestHandler: RequestHandler;
  private providerManager: ProviderManager;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;
  private healthStatus: HealthStatus;
  private startupTime: number;
  private config: UnknownObject = {};
  private mergedConfig: UnknownObject | null = null;
  private pipelineManager: PipelineManager | null = null;
  private routePools: Record<string, string[]> | null = null;
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> | null = null;
  private classifier: ConfigRequestClassifier | null = null;
  private classifierConfig: UnknownObject | null = null;
  private serviceContainer: ServiceContainer;

  // Debug enhancement properties
  private isDebugEnhanced = false;
  private serverMetrics: Map<string, { values: UnknownObject[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
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
      version: '0.50.1',
      description: 'Express.js HTTP server for RouteCodex',
      type: 'server',
    };

    super(moduleInfo);

    // Store module info for debug access
    const moduleInfoForDebug = moduleInfo;
    (this as UnknownObject).moduleInfo = moduleInfoForDebug;

    this.moduleConfigReader = new ModuleConfigReader(modulesConfigPath);
    this.errorHandling = new ErrorHandlingCenter();
    try {
      this.debugEventBus = (String(process.env.ROUTECODEX_ENABLE_DEBUGCENTER || '0') === '1') ? DebugEventBus.getInstance() : (null as any);
    } catch { this.debugEventBus = null as any; }
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('http-server');
    this.app = express();
    this.serviceContainer = ServiceContainer.getInstance();
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
    this.protocolHandler = new ProtocolHandler(this.requestHandler, this.providerManager, this.moduleConfigReader);

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Get default server configuration for initialization
   */
  private getDefaultServerConfig(): ServerConfig {
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
      logging: {
        level: 'info',
        enableConsole: true,
        enableFile: false,
        categories: ['server', 'api', 'request', 'config', 'error', 'message'],
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
   * Get server configuration from modules config
   */
  private async getServerConfig(): Promise<ServerConfig> {
    // Require merged configuration injected via initializeWithMergedConfig
    if (!this.mergedConfig) {
      throw new Error('Server configuration missing. Ensure merged-config is initialized.');
    }

    const mc: UnknownObject = this.mergedConfig as UnknownObject;
    const httpCfg = (((mc.modules as UnknownObject) || {} as UnknownObject)['httpserver'] as UnknownObject)?.['config'] as UnknownObject | undefined;
    const rootCfg: UnknownObject = (this.config as UnknownObject) || {};

    // Port field translation: support multiple configuration field names
    // Priority: httpserver.port > server.port > port (root level)
    let resolvedPort: number | undefined;

    // 1. Try httpserver.config.port from merged config
    if (typeof (httpCfg as any)?.port === 'number' && (httpCfg as any).port > 0) {
      resolvedPort = (httpCfg as any).port;
    }
    // 2. Try server.port from root config
    else if (typeof (rootCfg as any)?.server?.port === 'number' && (rootCfg as any)?.server?.port > 0) {
      resolvedPort = (rootCfg as any).server.port;
    }
    // 3. Try port from root config (user's current format)
    else if (typeof (rootCfg as any)?.port === 'number' && (rootCfg as any)?.port > 0) {
      resolvedPort = (rootCfg as any).port;
    }

    if (!(resolvedPort && resolvedPort > 0)) {
      throw new Error('HTTP server port is missing. Please set port, server.port, or httpserver.port in your user config (~/.routecodex/config.json).');
    }

    // Host field translation: support multiple configuration field names
    // Priority: httpserver.host > server.host > host (root level)
    let resolvedHost: string | undefined;

    // 1. Try httpserver.config.host from merged config
    if (typeof (httpCfg as any)?.host === 'string' && (httpCfg as any).host.trim()) {
      resolvedHost = (httpCfg as any).host.trim();
    }
    // 2. Try server.host from root config
    else if (typeof (rootCfg as any)?.server?.host === 'string' && (rootCfg as any)?.server?.host.trim()) {
      resolvedHost = (rootCfg as any).server.host.trim();
    }
    // 3. Try host from root config (user's current format)
    else if (typeof (rootCfg as any)?.host === 'string' && (rootCfg as any)?.host.trim()) {
      resolvedHost = (rootCfg as any).host.trim();
    }

    // Fallback to IPv4 localhost if no host found; avoid IPv6 by default
    resolvedHost = resolvedHost || '127.0.0.1';
    // Normalize host to IPv4-friendly values
    try {
      const lower = String(resolvedHost).toLowerCase();
      if (lower === 'localhost') { resolvedHost = '127.0.0.1'; }
      if (lower === '::' || lower === '::1') { resolvedHost = '127.0.0.1'; }
      if (lower === '0.0.0.0') { resolvedHost = '127.0.0.1'; }
    } catch { /* ignore normalization errors */ }
    const resolvedCors = (httpCfg as any)?.cors || (rootCfg as any)?.cors || { origin: '*', credentials: true };
    // Unified timeout override via env (in ms)
    const unifiedTimeout = Number(process.env.ROUTECODEX_TIMEOUT_MS || process.env.RCC_TIMEOUT_MS || NaN);
    const resolvedTimeout = !Number.isNaN(unifiedTimeout)
      ? unifiedTimeout
      : ((httpCfg as any)?.timeout ?? (rootCfg as any)?.timeout ?? 300000);
    const resolvedBodyLimit = (httpCfg as any)?.bodyLimit ?? (rootCfg as any)?.bodyLimit ?? '10mb';

    const logging = (rootCfg.logging as UnknownObject) || {};
    return {
      server: {
        port: resolvedPort as number,
        host: resolvedHost,
        cors: resolvedCors as any,
        timeout: Number(resolvedTimeout),
        bodyLimit: String(resolvedBodyLimit),
      },
      logging: {
        level: ((logging.level as string) || 'info') as 'debug' | 'info' | 'warn' | 'error',
        enableConsole: (logging.enableConsole as boolean) !== false,
        enableFile: (logging.enableFile as boolean) === true,
        filePath: logging.filePath as string,
        categories: (logging.categories as string[]) || [
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
  public async initializeWithMergedConfig(mergedConfig: UnknownObject): Promise<void> {
    try {
      console.log('🔄 Initializing HTTP server with merged configuration...');

      // Set up the server with merged configuration
      this.mergedConfig = mergedConfig;
      // Use the merged config directly for server configuration (port, host, etc.)
      this.config = mergedConfig;

      // Initialize DebugCenter file logging if configured
      const debugCenterConfig = (mergedConfig.modules as any)?.debugcenter?.config;
      if (debugCenterConfig?.enableFile && debugCenterConfig.filePath) {
        DebugFileLogger.initialize({
          filePath: debugCenterConfig.filePath,
          enabled: true,
        });
      }

      // Continue with normal initialization
      await this.initialize();

      console.log('✅ HTTP server initialized with merged configuration successfully');

      // Attach authMappings to protocol handler if available in merged config
      try {
        const pac = (this.mergedConfig as any)?.pipeline_assembler?.config;
        let authMappings = pac?.authMappings as Record<string, string> | undefined;
        // Fallback: derive from compatibilityConfig.keyMappings.global when assembler does not expose authMappings
        if (!authMappings) {
          const cc = (this.mergedConfig as any)?.compatibilityConfig;
          const km = cc?.keyMappings;
          const globalMap = km && typeof km === 'object' ? (km as any).global : undefined;
          if (globalMap && typeof globalMap === 'object') {
            authMappings = { ...globalMap } as Record<string, string>;
          }
        }
        if (authMappings && this.protocolHandler && typeof (this.protocolHandler as any).attachAuthMappings === 'function') {
          (this.protocolHandler as any).attachAuthMappings(authMappings);
        }
      } catch { /* ignore */ }
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
      const protocolHandlerModule = this.moduleConfigReader.getModuleConfigValue<UnknownObject>(
        'protocolhandler',
        {}
      );
      this.protocolHandler = new ProtocolHandler(this.requestHandler, this.providerManager, this.moduleConfigReader, (protocolHandlerModule || {}) as UnknownObject);

      // Initialize request handler
      await this.requestHandler.initialize();

      // Initialize provider manager
      await this.providerManager.initialize();

      // Initialize OpenAI router
      await this.protocolHandler.initialize();

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

      try {
        if (process.env.ROUTECODEX_ENABLE_DEBUGCENTER === '1') {
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
        }
      } catch { /* ignore */ }
    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Attach a pipeline manager to the OpenAI router (enables HTTP → Router → Pipeline layering)
   */
  public attachPipelineManager(pipelineManager: PipelineManager): void {
    this.pipelineManager = pipelineManager as PipelineManager;
    try {
      this.serviceContainer.registerInstance(ServiceTokens.PIPELINE_MANAGER, pipelineManager);
    } catch { /* ignore registration errors */ }
    try {
      if (this.protocolHandler && (this.protocolHandler as any).attachPipelineManager) {
        (this.protocolHandler as any).attachPipelineManager(pipelineManager);
      }
    } catch (error) {
      // Do not break server if attachment fails
      console.error('Failed to attach pipeline manager to OpenAI router:', error);
    }
    // Router handles its own route selection; no local resolver
  }

  /** Attach static route pools for round-robin dispatch */
  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_POOLS, routePools);
    } catch { /* ignore registration errors */ }
    try {
      if (this.protocolHandler && (this.protocolHandler as any).attachRoutePools) {
        (this.protocolHandler as any).attachRoutePools(routePools);
      }
    } catch (error) {
      console.error('Failed to attach route pools to OpenAI router:', error);
    }
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta;
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_META, routeMeta);
    } catch { /* ignore */ }
    try {
      if (this.protocolHandler && (this.protocolHandler as any).attachRouteMeta) {
        (this.protocolHandler as any).attachRouteMeta(routeMeta);
      }
    } catch (error) {
      console.error('Failed to attach route meta to OpenAI router:', error);
    }
  }

  /** Attach classification config to router */
  public attachRoutingClassifierConfig(classifierConfig: UnknownObject): void {
    this.classifierConfig = classifierConfig;
    try {
      if (this.protocolHandler && (this.protocolHandler as any).attachRoutingClassifierConfig) {
        (this.protocolHandler as any).attachRoutingClassifierConfig(classifierConfig);
      }
    } catch (error) {
      console.error('Failed to attach classifier config to OpenAI router:', error);
    }

    try {
      if (this.classifier) {
        this.serviceContainer.registerInstance(ServiceTokens.ROUTING_CLASSIFIER, this.classifier);
      }
    } catch { /* ignore */ }
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
   * Safely publish a DebugCenter event when enabled
   */
  private safePublishDebug(event: UnknownObject): void {
    try {
      if (String(process.env.ROUTECODEX_ENABLE_DEBUGCENTER || '0') === '1' && this.debugEventBus && typeof (this.debugEventBus as any).publish === 'function') {
        this.debugEventBus.publish(event as any);
      }
    } catch {
      // no-op when DebugCenter is disabled or unavailable
    }
  }

  /**
   * Record server metric
   */
  private recordServerMetric(operation: string, data: UnknownObject): void {
    if (!this.serverMetrics.has(operation)) {
      this.serverMetrics.set(operation, { values: [], lastUpdated: Date.now() });
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
  private addToRequestHistory(request: UnknownObject): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: UnknownObject): void {
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: UnknownObject): void {
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
          serverId: ((this as UnknownObject).moduleInfo as any).id,
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
  getDebugStatus(): UnknownObject {
    const moduleInfo = (this as any).moduleInfo as any;
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
  private getDebugInfo(): UnknownObject {
    const moduleInfo = (this as any).moduleInfo as any;
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
  private getServerMetrics(): UnknownObject {
    const metrics: UnknownObject = {};

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
    const rootCfg = (this.config as UnknownObject) || {};
    const dualStack: boolean = Boolean((rootCfg as any).dualStack ?? (rootCfg as any)?.server?.dualStack);
    const requestedHost = config.server.host;
    const hostsToBind: string[] = (() => {
      if (!dualStack) { return [requestedHost]; }
      const set = new Set<string>();
      const lower = String(requestedHost || '').toLowerCase();
      if (lower === 'localhost') { set.add('127.0.0.1'); set.add('::1'); }
      else if (lower === '127.0.0.1') { set.add('127.0.0.1'); set.add('::1'); }
      else if (lower === '::1') { set.add('::1'); set.add('127.0.0.1'); }
      else { set.add(requestedHost); }
      return Array.from(set.values());
    })();

    return new Promise((resolve, reject) => {
      const total = hostsToBind.length;
      let successes = 0;
      let errors = 0;
      let firstError: Error | null = null;

      const onBound = (host: string, srv: any) => {
        successes += 1;
        this._isRunning = true;
        this.startupTime = Date.now();
        this.servers.push(srv);
        if (!this.server) { this.server = srv; }
        this.safePublishDebug({
          sessionId: `p${config.server.port}_http_server_started_${Date.now()}`,
          moduleId: 'http-server',
          operationId: 'http_server_started',
          timestamp: Date.now(),
          type: 'start',
          position: 'middle',
          data: { port: config.server.port, host, uptime: this.getUptime() },
        });
        console.log(`🚀 RouteCodex HTTP Server started on http://${host}:${config.server.port}`);
        if (successes === 1) { resolve(); }
      };

      const onError = async (error: Error) => {
        errors += 1;
        if (!firstError) { firstError = error; }
        await this.handleError(error as Error, 'server_start');
        if (errors >= total && successes === 0) {
          reject(firstError || error);
        }
      };

      for (const h of hostsToBind) {
        try {
          const srv: any = this.app.listen(config.server.port, h, () => onBound(h, srv));
          srv.on('error', onError);
        } catch (e) {
          // synchronous error
          errors += 1;
          if (!firstError) { firstError = e as Error; }
        }
      }

      // If all attempts failed synchronously
      if (errors >= total && successes === 0) {
        reject(firstError || new Error('Failed to bind any host'));
      }
    });
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    try {
      const toClose: unknown[] = this.servers && this.servers.length ? this.servers : (this.server ? [this.server] : []);
      if (toClose.length) {
        await new Promise<void>((resolveAll) => {
          let remaining = toClose.length;
          const done = () => { remaining -= 1; if (remaining <= 0) {resolveAll();} };
          for (const srv of toClose) {
            try { (srv as any).close(() => done()); } catch { done(); }
          }
        });
        this._isRunning = false;
        this.servers = [];

        // Stop all components
        await this.protocolHandler.stop();
        await this.providerManager.stop();
        await this.requestHandler.stop();
        // Config manager doesn't need to be closed in new architecture
        await this.errorHandling.destroy();

        this.safePublishDebug({
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
        return;
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
    // const config = this.getDefaultServerConfig(); // Reserved for future use

    const providers = this.getUnifiedProvidersHealth();
    return {
      status: this._isRunning ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      memory: process.memoryUsage(),
      providers,
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
      dependencies: ['config-manager', 'request-handler', 'provider-manager', 'protocol-handler'],
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

        this.safePublishDebug({
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

    // Defer mounting OpenAI /v1 catch-all until after Anthropic endpoints to avoid shadowing

    // Anthropic API canonical endpoint /v1/messages (Anthropic SDK default)
    this.app.post('/v1/messages', async (req: Request, res: Response) => {
      try {
        if (!this.pipelineManager || !this.routePools) {
          return res.status(503).json({ error: { message: 'Pipeline not ready', code: 'pipeline_not_ready' } });
        }

        const requestId = `anth_${Date.now()}`;
        const pickFirst = (): string | null => {
          const pools = this.routePools || {} as Record<string, string[]>;
          // Prefer non-empty anthropic pool; otherwise fallback to default
          const anth = Array.isArray(pools['anthropic']) ? pools['anthropic'] : [];
          const def = Array.isArray(pools['default']) ? pools['default'] : [];
          const list = anth.length > 0 ? anth : def;
          if (list.length > 0) { return list[0]; }
          // As a last resort, pick the first pipeline id from any non-empty pool
          for (const v of Object.values(pools)) {
            if (Array.isArray(v) && v.length > 0) { return v[0]; }
          }
          return null;
        };

        let codexCaptured = false;
        const maybeCapture = async (payload: UnknownObject): Promise<void> => {
          if (codexCaptured) { return; }
          try {
            const ua = (req.get('user-agent') || '').toLowerCase();
            if (!(ua.includes('codex') || ua.includes('claude'))) { return; }
            const baseDir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
            await fs.mkdir(baseDir, { recursive: true });
            const sample = {
              requestId,
              endpoint: '/v1/messages',
              timestamp: Date.now(),
              headers: req.headers,
              data: payload,
            };
            await fs.writeFile(`${baseDir}/pipeline-in-${requestId}.json`, JSON.stringify(sample, null, 2));
            // Also save into dedicated replay subfolder for Anthropic validation
            try {
        const subDir = `${baseDir}/anth-replay`;
              await fs.mkdir(subDir, { recursive: true });
              await fs.writeFile(`${subDir}/anthropic-request-${requestId}.json`, JSON.stringify(sample, null, 2));
              // Capture tool_result blocks (if present) as separate snapshot(s)
              try {
                const body = (payload || {}) as any;
                const messages = Array.isArray(body?.messages) ? body.messages : [];
                const toolResults: any[] = [];
                for (const m of messages) {
                  const content = Array.isArray(m?.content) ? m.content : [];
                  for (const c of content) {
                    if (c && typeof c === 'object' && c.type === 'tool_result') {
                      toolResults.push({
                        tool_use_id: c.tool_use_id,
                        content: c.content ?? c.output ?? null,
                        is_error: !!c.is_error,
                        role: m.role,
                      });
                    }
                  }
                }
                if (toolResults.length > 0) {
                  const toolResCapture = {
                    requestId,
                    endpoint: '/v1/messages',
                    timestamp: Date.now(),
                    count: toolResults.length,
                    tool_results: toolResults,
                  };
                  await fs.writeFile(`${subDir}/anthropic-tool-results-${requestId}.json`, JSON.stringify(toolResCapture, null, 2));
                }
              } catch { /* ignore tool_result capture errors */ }
            } catch { /* ignore */ }
            codexCaptured = true;
          } catch { /* ignore */ }
        };

        await maybeCapture(req.body as UnknownObject);

        const pipelineId = pickFirst();
        if (!pipelineId) {
          return res.status(503).json({ error: { message: 'No pipelines available', code: 'no_pipelines' } });
        }

        // Use assembler-supplied meta to avoid parsing pipelineId
        const m = (this.routeMeta && this.routeMeta[pipelineId]) || null;
        try {
          console.log('[HTTP] anthropic /v1/messages pick', { pipelineId, hasMeta: !!m });
        } catch { /* ignore */ }
        const providerId = m?.providerId || 'unknown';
        const modelId = m?.modelId || 'unknown';

        // Optional: Replace only system prompt (tools untouched) if selector active
        try {
          const { shouldReplaceSystemPrompt, SystemPromptLoader } = await import('../utils/system-prompt-loader.js');
          const sel = shouldReplaceSystemPrompt();
          if (sel) {
            const loader = SystemPromptLoader.getInstance();
            const sys = await loader.getPrompt(sel);
            const currentSys = (req.body && typeof req.body === 'object' && (req.body as any).system) ? String((req.body as any).system) : '';
            const hasMdMarkers = /\bCLAUDE\.md\b|\bAGENT(?:S)?\.md\b/i.test(currentSys);
            if (sys && req.body && typeof req.body === 'object' && !hasMdMarkers) {
              req.body = { ...(req.body as Record<string, unknown>), system: sys } as any;
              try { res.setHeader('x-rc-system-prompt-source', sel); } catch { /* ignore */ }
            }
          }
          // Tool guidance and normalization are handled downstream in llmswitch-core
        } catch { /* non-blocking */ }

        const pipelineRequest = {
          data: req.body,
          route: {
            providerId,
            modelId,
            requestId,
            timestamp: Date.now(),
            pipelineId,
          },
          metadata: {
            method: req.method,
            url: '/v1/messages',
            headers: req.headers,
            targetProtocol: 'anthropic',
            endpoint: '/v1/messages'
          },
          debug: { enabled: true, stages: { llmSwitch: true, workflow: true, compatibility: true, provider: true } },
        } as UnknownObject;

        // Pre-SSE heartbeat for anthropic when waiting on pipeline (disabled when ROUTECODEX_DISABLE_ANTHROPIC_STREAM=1)
        let preHeartbeat: NodeJS.Timeout | null = null;
        const jsonHeartbeatEnabled2 = false;
        const disableAnthropicStreamB = process.env.ROUTECODEX_DISABLE_ANTHROPIC_STREAM === '1';
        if (!disableAnthropicStreamB && (req.body as any)?.stream && !res.headersSent) {
          try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('x-request-id', requestId);
            const interval = Math.max(5000, Number(process.env.ROUTECODEX_SSE_HEARTBEAT_MS || 15000));
            const send = () => {
              try { res.write(`event: ping\n` + `data: ${JSON.stringify({ type: 'ping', stage: 'pre', requestId, ts: Date.now() })}\n\n`); } catch { /* ignore */ }
            };
            send();
            preHeartbeat = setInterval(send, interval);
          } catch { /* ignore */ }
        }
        // (no JSON heartbeat for non-stream)

        const pipelineResponse = await this.pipelineManager.processRequest(pipelineRequest as any);
        const data = (pipelineResponse as any)?.data ?? pipelineResponse;
        // Capture final Anthropic JSON response (non-stream)
        const captureAnthropicResponse2 = async (payload: unknown) => {
          try {
            const baseDir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
            const subDir = `${baseDir}/anth-replay`;
            await fs.mkdir(subDir, { recursive: true });
            // No backfill: do not store tool_use for future mutation
            const digest = (() => {
              try {
                const obj = (payload && typeof payload === 'object') ? payload as any : {};
                const content = Array.isArray(obj.content) ? obj.content : [];
                const tools = content.filter((b: any) => b && b.type === 'tool_use');
                const first = tools.length ? tools[0] : null;
                return {
                  tool_use_count: tools.length,
                  first_tool_use: first ? {
                    id: first.id || null,
                    name: first.name || null,
                    input_keys: first.input && typeof first.input === 'object' ? Object.keys(first.input) : []
                  } : null,
                  stop_reason: obj.stop_reason || null
                };
              } catch { return { tool_use_count: 0, first_tool_use: null, stop_reason: null }; }
            })();
            const out = {
              requestId,
              endpoint: '/v1/messages',
              timestamp: Date.now(),
              response: { status: 200, headers: { 'x-rc-target-protocol': 'anthropic' } },
              data: payload,
              mappingDigest: digest,
            };
            await fs.writeFile(`${subDir}/anthropic-response-${requestId}.json`, JSON.stringify(out, null, 2));
          } catch { /* ignore */ }
        };
        if (!disableAnthropicStreamB && (req.body as any)?.stream) {
          res.status(200);
          const protocolHandlerAny = this.protocolHandler as unknown as { streamFromPipeline?: (response: unknown, requestId: string, res: Response, model?: string, protocol?: 'openai' | 'anthropic') => Promise<void> };
          if (protocolHandlerAny?.streamFromPipeline) {
            try { if (preHeartbeat) { clearInterval(preHeartbeat); preHeartbeat = null; } } catch { /* ignore */ }
            // no JSON heartbeat cleanup needed
            await protocolHandlerAny.streamFromPipeline(pipelineResponse, requestId, res, (req.body as any)?.model as string | undefined, 'anthropic');
            return;
          }
        }
        try { if (preHeartbeat) { clearInterval(preHeartbeat); preHeartbeat = null; } } catch { /* ignore */ }
        if (!res.headersSent) {
          try { res.setHeader('x-rc-target-protocol', 'anthropic'); } catch { /* ignore */ }
          try { res.setHeader('anthropic-version', '2023-06-01'); } catch { /* ignore */ }
        }
        await captureAnthropicResponse2(data);
        if (!res.headersSent) {
          res.status(200).json(data);
        } else {
          try { res.write(typeof data === 'string' ? data : JSON.stringify(data)); } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
        }
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: { message: (err as Error).message || 'Anthropic handler error' } });
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      }
    });

    // OpenAI API endpoints (mounted after Anthropic endpoints to prevent route shadowing)
    const protocolRouter = this.protocolHandler.getRouter();
    const protocolHandlerConfig = this.moduleConfigReader.getModuleConfigValue<UnknownObject>(
      'protocolhandler',
      {}
    );
    const basePath = (protocolHandlerConfig as any)?.basePath || '/v1/openai';

    // Mount router at configured base path and at /v1 for compatibility
    // Only mount at /v1 if basePath is not already /v1 to avoid conflicts
    this.app.use(basePath, protocolRouter);
    if (basePath !== '/v1') {
      this.app.use('/v1', protocolRouter);
    }

    // Lightweight debug endpoint to inspect routing state
    this.app.get('/debug/route-pools', async (_req: Request, res: Response) => {
      try {
        const ids = this.pipelineManager ? Array.from((this.pipelineManager as any).pipelines?.keys?.() || []) : [];
        return res.status(200).json({
          routePools: this.routePools,
          routeMeta: this.routeMeta ? Object.keys(this.routeMeta) : [],
          managerPipelines: ids,
        });
      } catch (e) {
        return res.status(500).json({ error: { message: (e as Error).message } });
      }
    });

    // Status endpoint
    this.app.get('/status', this.handleStatus.bind(this));

    // Configuration endpoint
    this.app.get('/config', async (req, res) => this.handleConfig(req, res));

    // Graceful shutdown endpoint (local control)
    this.app.post('/shutdown', async (_req: Request, res: Response) => {
      try {
        res.status(200).json({ ok: true, message: 'Shutting down' });
      } catch { /* ignore */ }
      // Defer actual stop to avoid tearing down before response flush
      setTimeout(async () => {
        try {
          await this.stop();
        } catch { /* ignore */ }
        try { process.exit(0); } catch { /* ignore */ }
      }, 50);
    });

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
          anthropic: '/v1/messages',
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
    this.app.use(async (error: UnknownObject, req: Request, res: Response, _next: NextFunction) => {
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

      await this.handleError(error as unknown as Error, 'request_handler');

      // Normalize sandbox/permission errors to explicit 500 with sandbox_denied
      const errObj = error as any;
      let status = (errObj.status as number) || (errObj.statusCode as number) || 500;
      let code = (errObj.code as string) || 'internal_error';
      let type = error.type || 'internal_error';
      let message = error.message || 'Internal Server Error';
      try {
        const det = ErrorHandlingUtils.detectSandboxPermissionError(error);
        if (det.isSandbox) {
          status = 500;
          code = 'sandbox_denied';
          type = 'server_error';
          if (!message || message === 'Internal Server Error') {
            message = 'Operation denied by sandbox or permission policy';
          }
        }
      } catch { /* ignore */ }

      res.status(status).json({
        error: {
          message,
          type,
          code,
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
      try {
        console.error('Uncaught Exception:', error);
        await this.handleError(error, 'uncaught_exception');
        // Do NOT exit; keep the server alive to avoid interrupting in-flight sessions.
      } catch { /* ignore */ }
    });

    // Handle unhandled promise rejections (log and continue; do NOT exit process)
    process.on('unhandledRejection', async (reason, promise) => {
      try {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        await this.handleError(
          reason instanceof Error ? reason : new Error(String(reason)),
          'unhandled_rejection'
        );
      } catch { /* ignore */ }
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
    const hasManager = !!this.pipelineManager;
    const hasRoutePools = !!this.routePools && Object.keys(this.routePools || {}).length > 0;
    const isReady = this._isInitialized && this._isRunning && hasManager && hasRoutePools;
    const status = isReady ? 'ready' : 'not_ready';

    res.status(isReady ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        initialized: this._isInitialized,
        running: this._isRunning,
        pipelineManagerAttached: hasManager,
        routePoolsAttached: hasRoutePools,
        routePoolsCount: hasRoutePools ? Object.values(this.routePools || {}).reduce((a:number,b:any)=>a+((b||[]).length),0) : 0,
        providers: this.getUnifiedProvidersHealth(),
      },
    });
  }

  /**
   * Merge provider health from ProviderManager with pipeline-derived provider health
   * so that /health reflects active pipelines in the new architecture.
   */
  private getUnifiedProvidersHealth(): Record<string, ProviderHealth> {
    const pm = this.providerManager?.getAllProvidersHealth?.() || {};
    const out: Record<string, ProviderHealth> = { ...pm };

    try {
      if (this.pipelineManager && typeof (this.pipelineManager as any).getPipelineStatus === 'function') {
        const statusMap = (this.pipelineManager as any).getPipelineStatus() as Record<string, any>;
        const meta = (this.routeMeta || {}) as Record<string, { providerId: string; modelId: string; keyId: string }>;
        for (const [pipelineId, st] of Object.entries(statusMap || {})) {
          const providerKey = meta[pipelineId]?.providerId || pipelineId;
          const mod = (st as any)?.modules?.provider as { type?: string; state?: string } | undefined;
          const ok = (mod?.state || '').toLowerCase() === 'ready';
          if (!out[providerKey]) {
            out[providerKey] = {
              status: ok ? 'healthy' : 'unknown',
              consecutiveFailures: 0,
              lastCheck: new Date().toISOString(),
            };
          }
        }
      }
    } catch {
      // non-fatal: keep pm-only map
    }
    return out;
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
        enabled_providers: Object.values(config.providers).filter((p: UnknownObject) => (p as UnknownObject).enabled).length,
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
      providers: Object.keys(config.providers).reduce((acc: UnknownObject, key: string) => {
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
        requestHandler: this.requestHandler.getInfo(),
        providerManager: this.providerManager.getInfo(),
        protocolRouter: this.protocolHandler.getInfo(),
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
