/**
 * RouteCodex Debug System Manager
 *
 * This file provides the main Debug System Manager that coordinates all debugging
 * components including adapters, API extensions, WebSocket server, and utilities.
 */

import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlerRegistry } from '../utils/error-handler-registry.js';
import { DebugUtilsStatic, DebugUtilsImpl } from '../utils/debug-utils.js';
import { BaseDebugAdapter } from './base-debug-adapter.js';
import { ModuleDebugAdapterImpl } from './module-debug-adapter.js';
import { HttpServerDebugAdapterImpl } from './http-server-debug-adapter.js';
import { DebugAPIExtensionImpl } from './debug-api-extension.js';
// import { any } from './websocket-debug-server.js';
import type {
  DebugSystemOptions,
  DebugAdapter,
  DebugAdapterConfig,
  DebugContext,
  DebugData,
  DebugSystemHealth,
  DebugConfiguration
} from '../types/debug-types.js';

/**
 * Main Debug System Manager
 */
export class DebugSystemManager {
  private debugEventBus: DebugEventBus;
  private errorRegistry: ErrorHandlerRegistry;
  private debugUtils: DebugUtilsImpl;
  private adapters: Map<string, DebugAdapter> = new Map();
  private apiExtension?: DebugAPIExtensionImpl;
  private wsServer?: any;
  private config: DebugConfiguration;
  private options: DebugSystemOptions;
  private initialized = false;
  private startTime: number;

  /**
   * Constructor
   */
  constructor(options: DebugSystemOptions = {}) {
    this.options = {
      enabled: true,
      logLevel: 'detailed',
      maxEntries: 1000,
      enableConsole: true,
      enableFileLogging: false,
      enableWebSocket: false,
      wsPort: 8081,
      enableRestApi: false,
      restPort: 8080,
      enablePerformanceMonitoring: true,
      enableMemoryProfiling: true,
      enableRequestCapture: true,
      enableErrorTracking: true,
      adapters: [],
      ...options
    };

    this.debugEventBus = DebugEventBus.getInstance();
    this.errorRegistry = ErrorHandlerRegistry.getInstance();
    this.debugUtils = DebugUtilsStatic.getInstance();
    this.startTime = Date.now();

    // Initialize configuration
    this.config = this.createDefaultConfiguration();
  }

  /**
   * Initialize the debug system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Initialize error registry
      await this.errorRegistry.initialize();

      // Initialize adapters
      await this.initializeAdapters();

      // Initialize API extension if enabled
      if (this.options.enableRestApi) {
        await this.initializeAPIExtension();
      }

      // Initialize WebSocket server if enabled
      if (this.options.enableWebSocket) {
        await this.initializeWebSocketServer();
      }

      // Update initialization status
      this.initialized = true;

      // Publish system initialized event
      this.publishEvent('debug_system_initialized', {
        options: this.options,
        config: this.config,
        adapters: Array.from(this.adapters.keys()),
        timestamp: Date.now()
      });

      if (this.options.enableConsole) {
        console.log('RouteCodex Debug System initialized successfully');
      }

    } catch (error) {
      await this.handleError('initialization', error as Error);
      throw error;
    }
  }

  /**
   * Start debugging for a specific context
   */
  async startDebugging(context: DebugContext): Promise<void> {
    if (!this.initialized) {
      throw new Error('Debug system is not initialized');
    }

    try {
      // Start debugging in all adapters
      const startPromises = Array.from(this.adapters.values()).map(adapter =>
        adapter.startDebugging(context).catch(error => {
          console.warn(`Failed to start debugging in adapter ${adapter.id}:`, error);
        })
      );

      await Promise.all(startPromises);

      // Publish session started event
      this.publishEvent('debug_session_started', {
        context,
        adapters: this.adapters.size,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('start_debugging', error as Error, { context });
      throw error;
    }
  }

  /**
   * Stop debugging for a specific context
   */
  async stopDebugging(context: DebugContext): Promise<void> {
    try {
      // Stop debugging in all adapters
      const stopPromises = Array.from(this.adapters.values()).map(adapter =>
        adapter.stopDebugging(context).catch(error => {
          console.warn(`Failed to stop debugging in adapter ${adapter.id}:`, error);
        })
      );

      await Promise.all(stopPromises);

      // Publish session ended event
      this.publishEvent('debug_session_ended', {
        context,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('stop_debugging', error as Error, { context });
    }
  }

  /**
   * Get debug data for a specific context
   */
  async getDebugData(context: DebugContext): Promise<DebugData[]> {
    if (!this.initialized) {
      throw new Error('Debug system is not initialized');
    }

    try {
      // Collect debug data from all adapters
      const dataPromises = Array.from(this.adapters.values()).map(async adapter => {
        try {
          return await adapter.getDebugData(context);
        } catch (error) {
          console.warn(`Failed to get debug data from adapter ${adapter.id}:`, error);
          return null;
        }
      });

      const allData = await Promise.all(dataPromises);

      // Filter out null results
      return allData.filter((data): data is DebugData => data !== null);

    } catch (error) {
      await this.handleError('get_debug_data', error as Error, { context });
      throw error;
    }
  }

  /**
   * Register a debug adapter
   */
  async registerAdapter(adapter: DebugAdapter): Promise<void> {
    try {
      // Initialize adapter if not already initialized
      if (!adapter.isInitialized) {
        await adapter.initialize();
      }

      // Store adapter
      this.adapters.set(adapter.id, adapter);

      // Register with API extension if available
      if (this.apiExtension) {
        await this.apiExtension.registerAdapter(adapter);
      }

      // Publish adapter registered event
      this.publishEvent('debug_adapter_registered', {
        adapterId: adapter.id,
        adapterType: adapter.type,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('register_adapter', error as Error, { adapterId: adapter.id });
      throw error;
    }
  }

  /**
   * Unregister a debug adapter
   */
  async unregisterAdapter(adapterId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return;
    }

    try {
      // Unregister from API extension if available
      if (this.apiExtension) {
        await this.apiExtension.unregisterAdapter(adapterId);
      }

      // Destroy adapter
      await adapter.destroy();

      // Remove adapter
      this.adapters.delete(adapterId);

      // Publish adapter unregistered event
      this.publishEvent('debug_adapter_unregistered', {
        adapterId,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('unregister_adapter', error as Error, { adapterId });
      throw error;
    }
  }

  /**
   * Get system health status
   */
  getHealth(): DebugSystemHealth {
    const adapterHealths = Array.from(this.adapters.values()).map(adapter => adapter.getHealth());

    // Calculate overall system health
    const avgScore = adapterHealths.length > 0
      ? adapterHealths.reduce((sum, health) => sum + health.score, 0) / adapterHealths.length
      : 100;

    const overallStatus = avgScore >= 80 ? 'healthy' :
                         avgScore >= 50 ? 'degraded' : 'unhealthy';

    // Collect all issues
    const allIssues = adapterHealths.flatMap(health => health.issues);

    return {
      status: overallStatus,
      lastCheck: Date.now(),
      score: avgScore,
      components: {
        adapters: adapterHealths,
        websocket: this.wsServer?.getHealth(),
        restApi: this.apiExtension?.getHealth()
      },
      issues: allIssues,
      metrics: {
        uptime: Date.now() - this.startTime,
        totalSessions: this.calculateTotalSessions(),
        activeSessions: this.calculateActiveSessions(),
        totalEvents: this.calculateTotalEvents(),
        totalErrors: this.calculateTotalErrors(),
        memoryUsage: DebugUtilsStatic.getMemoryUsage()
      }
    };
  }

  /**
   * Get system configuration
   */
  getConfiguration(): DebugConfiguration {
    return DebugUtilsStatic.deepClone(this.config);
  }

  /**
   * Update system configuration
   */
  async updateConfiguration(config: Partial<DebugConfiguration>): Promise<void> {
    try {
      // Merge configuration
      this.config = {
        ...this.config,
        ...config,
        global: {
          ...this.config.global,
          ...config.global
        },
        adapters: config.adapters || this.config.adapters
      };

      // Update adapter configurations
      for (const adapterConfig of this.config.adapters) {
        const adapter = this.adapters.get(adapterConfig.id);
        if (adapter) {
          await adapter.configure(adapterConfig.config || {});
        }
      }

      // Publish configuration updated event
      this.publishEvent('debug_system_config_updated', {
        config: this.config,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('update_configuration', error as Error);
      throw error;
    }
  }

  /**
   * Create and register a module debug adapter
   */
  async createModuleAdapter(
    moduleId: string,
    moduleInfo: {
      id: string;
      name: string;
      version: string;
      type: string;
    },
    config?: Record<string, any>
  ): Promise<ModuleDebugAdapterImpl> {
    const adapterConfig: DebugAdapterConfig = {
      id: moduleId,
      type: 'module',
      className: 'ModuleDebugAdapterImpl',
      config,
      enabled: true
    };

    const adapter = new ModuleDebugAdapterImpl(
      adapterConfig,
      this.debugUtils,
      moduleInfo
    );

    await this.registerAdapter(adapter);
    return adapter;
  }

  /**
   * Create and register an HTTP server debug adapter
   */
  async createHttpServerAdapter(
    serverId: string,
    serverInfo: {
      host: string;
      port: number;
      protocol: string;
    },
    config?: Record<string, any>
  ): Promise<HttpServerDebugAdapterImpl> {
    const adapterConfig: DebugAdapterConfig = {
      id: serverId,
      type: 'server',
      className: 'HttpServerDebugAdapterImpl',
      config,
      enabled: true
    };

    const adapter = new HttpServerDebugAdapterImpl(
      adapterConfig,
      this.debugUtils,
      serverInfo
    );

    await this.registerAdapter(adapter);
    return adapter;
  }

  /**
   * Cleanup all resources
   */
  async destroy(): Promise<void> {
    try {
      // Stop WebSocket server
      if (this.wsServer) {
        await this.wsServer.stop();
        this.wsServer = undefined;
      }

      // Destroy API extension
      if (this.apiExtension) {
        await this.apiExtension.destroy();
        this.apiExtension = undefined;
      }

      // Destroy all adapters
      const destroyPromises = Array.from(this.adapters.values()).map(adapter =>
        adapter.destroy().catch(error => {
          console.warn(`Failed to destroy adapter ${adapter.id}:`, error);
        })
      );

      await Promise.all(destroyPromises);

      // Clear adapters
      this.adapters.clear();

      // Reset initialization status
      this.initialized = false;

      // Publish system destroyed event
      this.publishEvent('debug_system_destroyed', {
        uptime: Date.now() - this.startTime,
        adaptersDestroyed: destroyPromises.length,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('destroy', error as Error);
      throw error;
    }
  }

  /**
   * Initialize adapters
   */
  private async initializeAdapters(): Promise<void> {
    for (const adapterConfig of this.options.adapters || []) {
      try {
        const adapter = await this.createAdapterFromConfig(adapterConfig);
        await this.registerAdapter(adapter);
      } catch (error) {
        console.warn(`Failed to initialize adapter ${adapterConfig.id}:`, error);
      }
    }
  }

  /**
   * Create adapter from configuration
   */
  private async createAdapterFromConfig(config: DebugAdapterConfig): Promise<DebugAdapter> {
    switch (config.type) {
      case 'module':
        return new ModuleDebugAdapterImpl(
          config,
          this.debugUtils,
          (config.config as any)?.moduleInfo || {
            id: config.id,
            name: config.id,
            version: '1.0.0',
            type: 'module'
          }
        );
      case 'server':
        return new HttpServerDebugAdapterImpl(
          config,
          this.debugUtils,
          (config.config as any)?.serverInfo || {
            host: 'localhost',
            port: 3000,
            protocol: 'http'
          }
        );
      default:
        throw new Error(`Unknown adapter type: ${config.type}`);
    }
  }

  /**
   * Initialize API extension
   */
  private async initializeAPIExtension(): Promise<void> {
    this.apiExtension = new DebugAPIExtensionImpl({
      host: 'localhost',
      port: this.options.restPort || 8080,
      path: '/debug',
      enableCors: true,
      enableAuth: false
    });

    await this.apiExtension.initialize();

    // Register all existing adapters
    for (const adapter of this.adapters.values()) {
      await this.apiExtension.registerAdapter(adapter);
    }
  }

  /**
   * Initialize WebSocket server
   */
  private async initializeWebSocketServer(): Promise<void> {
    // WebSocket server temporarily disabled
    /*
    this.wsServer = new any(
      {
        host: 'localhost',
        port: this.options.wsPort || 8081,
        path: '/debug'
      },
      {
        maxConnections: 100,
        enableCompression: true,
        enableHeartbeat: true,
        heartbeatInterval: 30000 // 30 seconds
      }
    );

    await this.wsServer.start();
    */
  }

  /**
   * Create default configuration
   */
  private createDefaultConfiguration(): DebugConfiguration {
    return {
      global: {
        enabled: this.options.enabled || true,
        logLevel: this.options.logLevel || 'detailed',
        maxEntries: this.options.maxEntries || 1000,
        enableConsole: this.options.enableConsole || true,
        enableFileLogging: this.options.enableFileLogging || false,
        enableWebSocket: this.options.enableWebSocket || false,
        enableRestApi: this.options.enableRestApi || false,
        wsPort: this.options.wsPort || 8081,
        restPort: this.options.restPort || 8080,
        enablePerformanceMonitoring: this.options.enablePerformanceMonitoring || true,
        enableMemoryProfiling: this.options.enableMemoryProfiling || true,
        enableRequestCapture: this.options.enableRequestCapture || true,
        enableErrorTracking: this.options.enableErrorTracking || true
      },
      adapters: this.options.adapters || [],
      websocket: {
        host: 'localhost',
        port: this.options.wsPort || 8081,
        path: '/debug',
        maxConnections: 100,
        enableCompression: true,
        enableHeartbeat: true,
        heartbeatInterval: 30000
      },
      restApi: {
        host: 'localhost',
        port: this.options.restPort || 8080,
        path: '/debug',
        enableCors: true,
        enableAuth: false
      },
      fileLogging: {
        enabled: false,
        logDirectory: './logs/debug',
        maxFileSize: 10485760, // 10MB
        maxFiles: 10,
        rotateInterval: '1d'
      },
      performance: {
        enabled: this.options.enablePerformanceMonitoring || true,
        samplingRate: 0.1,
        maxSamples: 1000,
        reportInterval: 60000 // 1 minute
      },
      memory: {
        enabled: this.options.enableMemoryProfiling || true,
        samplingRate: 0.05,
        maxSamples: 100,
        reportInterval: 300000 // 5 minutes
      }
    };
  }

  /**
   * Calculate total sessions across all adapters
   */
  private calculateTotalSessions(): number {
    return Array.from(this.adapters.values())
      .reduce((total, adapter) => total + adapter.getStats().totalSessions, 0);
  }

  /**
   * Calculate active sessions across all adapters
   */
  private calculateActiveSessions(): number {
    return Array.from(this.adapters.values())
      .reduce((total, adapter) => total + adapter.getStats().activeSessions, 0);
  }

  /**
   * Calculate total events across all adapters
   */
  private calculateTotalEvents(): number {
    return Array.from(this.adapters.values())
      .reduce((total, adapter) => total + adapter.getStats().totalEvents, 0);
  }

  /**
   * Calculate total errors across all adapters
   */
  private calculateTotalErrors(): number {
    return Array.from(this.adapters.values())
      .reduce((total, adapter) => total + adapter.getStats().totalErrors, 0);
  }

  /**
   * Handle error
   */
  private async handleError(operation: string, error: Error, context?: Record<string, any>): Promise<void> {
    await this.errorRegistry.handleError(
      error,
      `debug_system_${operation}`,
      'debug_system_manager',
      {
        operation,
        ...context
      }
    );

    this.publishEvent('debug_system_error', {
      operation,
      error: error.message,
      stack: error.stack,
      context,
      timestamp: Date.now()
    });
  }

  /**
   * Publish event to DebugEventBus
   */
  private publishEvent(eventType: string, data: unknown): void {
    try {
      this.debugEventBus.publish({
        sessionId: `debug_system_manager`,
        moduleId: 'debug_system_manager',
        operationId: eventType,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data
      });
    } catch (error) {
      console.warn(`Failed to publish debug event:`, error);
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(options?: DebugSystemOptions): DebugSystemManager {
    if (!(globalThis as any).RouteCodexDebugManager) {
      (globalThis as any).RouteCodexDebugManager = new DebugSystemManager(options);
    }
    return (globalThis as any).RouteCodexDebugManager;
  }
}

// Export singleton instance
export const debugSystemManager = DebugSystemManager.getInstance();