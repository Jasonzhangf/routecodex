/**
 * Provider Manager
 * Manages provider lifecycle, health monitoring, and failover
 */

import { BaseModule, type ModuleInfo } from './base-module.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { ErrorHandlingUtils } from '../utils/error-handling-utils.js';
import {
  type ProviderConfig,
  type ProviderHealth,
  type ProviderStats,
  type ServerConfig,
  RouteCodexError,
} from '../server/types.js';
import type { UnknownObject } from '../types/common-types.js';

/**
 * Provider management options
 */
export interface ProviderManagerOptions {
  healthCheckInterval?: number;
  autoRecoveryEnabled?: boolean;
  maxConsecutiveFailures?: number;
  providerTimeout?: number;
  enableMetrics?: boolean;
}

/**
 * Provider instance with metadata
 */
interface ProviderInstance {
  provider: any;
  config: ProviderConfig;
  lastHealthCheck: number;
  isActive: boolean;
  consecutiveFailures: number;
  stats: ProviderStats;
}

/**
 * Provider Manager class
 */
export class ProviderManager extends BaseModule {
  private config: ServerConfig;
  private errorHandling: ErrorHandlingCenter;
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;
  private options: ProviderManagerOptions;
  private providers: Map<string, ProviderInstance> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metrics: {
    totalHealthChecks: number;
    failedHealthChecks: number;
    providerSwitches: number;
    averageRecoveryTime: number;
  };

  constructor(config: ServerConfig, options: ProviderManagerOptions = {}) {
    const moduleInfo: ModuleInfo = {
      id: 'provider-manager',
      name: 'ProviderManager',
      version: '0.0.1',
      description: 'Manages provider lifecycle, health monitoring, and failover',
    };

    super(moduleInfo);

    this.config = config;
    try {
      this.debugEventBus = (String(process.env.ROUTECODEX_ENABLE_DEBUGCENTER || '0') === '1') ? DebugEventBus.getInstance() : (null as any);
    } catch { this.debugEventBus = null as any; }
    this.errorHandling = new ErrorHandlingCenter();
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('provider-manager');

    // Set default options
    this.options = {
      healthCheckInterval: 30000, // 30 seconds
      autoRecoveryEnabled: true,
      maxConsecutiveFailures: 3,
      providerTimeout: 30000,
      enableMetrics: true,
      ...options,
    };

    // Initialize metrics
    this.metrics = {
      totalHealthChecks: 0,
      failedHealthChecks: 0,
      providerSwitches: 0,
      averageRecoveryTime: 0,
    };
  }

  /**
   * Initialize the provider manager
   */
  public async initialize(_config?: UnknownObject): Promise<void> {
    try {
      await ErrorHandlingUtils.initialize();
      await this.errorHandling.initialize();

      // Register error messages for provider manager
      this.errorUtils.registerMessage(
        'provider_initialization_error',
        'Provider initialization failed',
        'high',
        'provider',
        'Failed to initialize AI provider',
        'Check provider configuration and credentials'
      );

      this.errorUtils.registerMessage(
        'provider_health_check_error',
        'Provider health check failed',
        'medium',
        'provider',
        'Provider health monitoring failed',
        'Check provider connectivity and configuration'
      );

      this.errorUtils.registerMessage(
        'provider_switch_error',
        'Provider switch failed',
        'medium',
        'provider',
        'Failed to switch to backup provider',
        'Check provider availability and configuration'
      );

      this.errorUtils.registerMessage(
        'provider_config_error',
        'Provider configuration error',
        'high',
        'configuration',
        'Invalid provider configuration',
        'Validate provider settings in configuration file'
      );

      // Register error handlers for provider manager
      this.errorUtils.registerHandler(
        'provider_initialization_error',
        async context => {
          console.error(`Provider initialization error: ${context.error}`);
          // Could implement automatic provider retry or fallback
        },
        1,
        'Handle provider initialization errors'
      );

      this.errorUtils.registerHandler(
        'provider_health_check_error',
        async context => {
          console.warn(`Provider health check error: ${context.error}`);
          // Could implement automatic provider restart
        },
        2,
        'Handle provider health check errors'
      );

      // Initialize all configured providers
      await this.initializeProviders();

      // Start health monitoring
      this.startHealthMonitoring();

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_manager_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerCount: this.providers.size,
          healthCheckInterval: this.options.healthCheckInterval,
          autoRecoveryEnabled: this.options.autoRecoveryEnabled,
        },
      } as unknown);

      // Record initialization metric
      this.recordModuleMetric('initialization', {
        providerCount: this.providers.size,
        healthCheckInterval: this.options.healthCheckInterval,
        autoRecoveryEnabled: this.options.autoRecoveryEnabled,
        maxConsecutiveFailures: this.options.maxConsecutiveFailures,
      });
    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Initialize all configured providers
   */
  private async initializeProviders(): Promise<void> {
    // In pipeline-first architecture, providers are managed by PipelineManager.
    // Keep no-op to preserve legacy initialization flow without side effects.
    return;
  }

  /**
   * Add a new provider
   */
  public async addProvider(providerId: string, config: ProviderConfig): Promise<void> {
    // Deprecated in pipeline-first mode. Keep silent no-op for backward compatibility.
    void providerId; void config;
    return;
  }

  /**
   * Remove a provider
   */
  public async removeProvider(providerId: string): Promise<void> {
    try {
      const providerInstance = this.providers.get(providerId);
      if (!providerInstance) {
        throw new Error(`Provider ${providerId} not found`);
      }

      await providerInstance.provider.destroy();
      this.providers.delete(providerId);

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_removed',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
        },
      } as unknown);
    } catch (error) {
      await this.handleError(error as Error, 'remove_provider');
      throw error;
    }
  }

  /**
   * Get provider by ID
   */
  public getProvider(providerId: string): any | null {
    const providerInstance = this.providers.get(providerId);
    return providerInstance?.provider || null;
  }

  /**
   * Get all active providers
   */
  public getActiveProviders(): any[] {
    const activeProviders: any[] = [];

    for (const [_providerId, providerInstance] of this.providers.entries()) { // eslint-disable-line @typescript-eslint/no-unused-vars
      if (providerInstance.isActive) {
        activeProviders.push(providerInstance.provider);
      }
    }

    return activeProviders;
  }

  /**
   * Get provider health status
   */
  public getProviderHealth(providerId: string): ProviderHealth | null {
    const providerInstance = this.providers.get(providerId);
    if (!providerInstance) {
      return null;
    }

    return providerInstance.provider.getHealth();
  }

  /**
   * Get all providers health status
   */
  public getAllProvidersHealth(): Record<string, ProviderHealth> {
    const healthStatus: Record<string, ProviderHealth> = {};
    // Providers are managed by pipelines; legacy map may be empty.
    return healthStatus;
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.options.healthCheckInterval || 30000);

    // Perform initial health check
    this.performHealthChecks();
  }

  /**
   * Perform health checks on all providers
   */
  private async performHealthChecks(): Promise<void> {
    this.metrics.totalHealthChecks++;
    if (this.providers.size === 0) { return; }
    const healthCheckPromises = Array.from(this.providers.entries()).map(
      async ([_providerId, providerInstance]) => {
        try {
          const startTime = Date.now();
          const health = await providerInstance.provider.healthCheck();
          const duration = Date.now() - startTime;

          // Update provider instance
          providerInstance.lastHealthCheck = Date.now();
          providerInstance.stats = providerInstance.provider.getStats();

          // Handle health status changes
          if (health.status === 'healthy' && !providerInstance.isActive) {
            await this.handleProviderRecovery(_providerId, providerInstance);
          } else if (health.status === 'unhealthy' && providerInstance.isActive) {
            await this.handleProviderFailure(_providerId, providerInstance, health);
          }

          (this.debugEventBus as any)?.publish({
            sessionId: `session_${Date.now()}`,
            moduleId: 'provider-manager',
            operationId: 'provider_health_check',
            timestamp: Date.now(),
            type: 'start',
            position: 'middle',
            data: {
              providerId: _providerId,
              healthStatus: health.status,
              responseTime: health.responseTime,
              duration,
            },
          } as unknown);
        } catch (error) {
          this.metrics.failedHealthChecks++;
          await this.handleProviderFailure(_providerId, providerInstance, {
            status: 'unhealthy',
            error: error instanceof Error ? error.message : String(error),
            consecutiveFailures: 0,
            lastCheck: new Date().toISOString(),
            responseTime: 0,
          });
        }
      }
    );

    await Promise.allSettled(healthCheckPromises);
  }

  /**
   * Handle provider failure
   */
  private async handleProviderFailure(
    providerId: string,
    providerInstance: ProviderInstance,
    health: ProviderHealth
  ): Promise<void> {
    providerInstance.consecutiveFailures++;

    const maxFailures = this.options.maxConsecutiveFailures || 3;
    if (providerInstance.consecutiveFailures >= maxFailures) {
      providerInstance.isActive = false;

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_deactivated',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          providerId,
          consecutiveFailures: providerInstance.consecutiveFailures,
          reason: health.error || 'Unknown',
        },
      } as unknown);
    }
  }

  /**
   * Handle provider recovery
   */
  private async handleProviderRecovery(
    providerId: string,
    providerInstance: ProviderInstance
  ): Promise<void> {
    providerInstance.isActive = true;
    providerInstance.consecutiveFailures = 0;

    // Update recovery time metrics
    const recoveryTime = Date.now() - providerInstance.lastHealthCheck;
    if (this.metrics.totalHealthChecks === 1) {
      this.metrics.averageRecoveryTime = recoveryTime;
    } else {
      this.metrics.averageRecoveryTime =
        (this.metrics.averageRecoveryTime * (this.metrics.totalHealthChecks - 1) + recoveryTime) /
        this.metrics.totalHealthChecks;
    }

    (this.debugEventBus as any)?.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'provider-manager',
      operationId: 'provider_recovered',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        providerId,
        recoveryTime,
        consecutiveFailures: 0,
      },
    } as unknown);
  }

  /**
   * Switch provider for load balancing or failover
   */
  public async switchProvider(currentProviderId?: string): Promise<string> {
    const availableProviders = this.getActiveProviders();

    if (availableProviders.length === 0) {
      throw new RouteCodexError('No active providers available', 'no_active_providers', 503);
    }

    // Simple round-robin selection for now
    const providerIds = availableProviders.map(p => p.getModuleInfo().id);
    const currentIndex = providerIds.indexOf(currentProviderId || '');
    const nextIndex = (currentIndex + 1) % providerIds.length;
    const selectedProvider = providerIds[nextIndex];

    if (selectedProvider !== currentProviderId) {
      this.metrics.providerSwitches++;

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_switch',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          fromProvider: currentProviderId,
          toProvider: selectedProvider,
          availableProviders: availableProviders.length,
        },
      } as unknown);
    }

    return selectedProvider;
  }

  /**
   * Update provider configuration
   */
  public async updateProviderConfig(
    providerId: string,
    newConfig: Partial<ProviderConfig>
  ): Promise<void> {
    try {
      const providerInstance = this.providers.get(providerId);
      if (!providerInstance) {
        throw new Error(`Provider ${providerId} not found`);
      }

      await providerInstance.provider.updateConfig(newConfig);
      providerInstance.config = { ...providerInstance.config, ...newConfig };

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_config_updated',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
          changes: Object.keys(newConfig),
        },
      } as unknown);
    } catch (error) {
      await this.handleError(error as Error, 'update_provider_config');
      throw error;
    }
  }

  /**
   * Get best provider for request based on load and health
   */
  public getBestProviderForRequest(
    modelId?: string,
    _requestType: 'chat' | 'completion' | 'embedding' = 'chat'
  ): any | null {
    const activeProviders = this.getActiveProviders();
    if (activeProviders.length === 0) {
      return null;
    }

    // Filter providers that support the requested model
    const suitableProviders = activeProviders.filter(provider => {
      if (modelId) {
        return provider.isModelSupported(modelId);
      }
      return true;
    });

    if (suitableProviders.length === 0) {
      return null;
    }

    // Select provider based on load and health
    return this.selectProviderByStrategy(suitableProviders);
  }

  /**
   * Select provider using configured strategy
   */
  private selectProviderByStrategy(providers: any[]): any {
    // Default strategy: round-robin with health consideration
    const healthyProviders = providers.filter(p => p.getHealth().status === 'healthy');

    if (healthyProviders.length > 0) {
      // Use round-robin among healthy providers
      const providerIds = healthyProviders.map(p => p.getModuleInfo().id);
      const currentIndex = this.metrics.providerSwitches % providerIds.length;
      return healthyProviders[currentIndex];
    }

    // Fallback to any available provider if none are healthy
    return providers[0];
  }

  /**
   * Get provider load statistics
   */
  public getProviderLoadStats(): Array<{
    providerId: string;
    load: number;
    health: string;
    requestsPerMinute: number;
    averageResponseTime: number;
  }> {
    const stats: Array<{
      providerId: string;
      load: number;
      health: string;
      requestsPerMinute: number;
      averageResponseTime: number;
    }> = [];

    // const now = Date.now();
    // const oneMinuteAgo = now - 60000; // Reserved for future use

    for (const [providerId, providerInstance] of this.providers.entries()) {
      const providerStats = providerInstance.stats || { averageResponseTime: 0, totalRequests: 0 } as any;
      const health = providerInstance.provider?.getHealth?.() || { status: 'unknown' } as any;

      // Calculate requests per minute (simplified)
      const requestsPerMinute = providerStats.totalRequests; // This could be enhanced with time-based tracking

      // Calculate load based on recent requests and response time
      const load = Math.min(
        100,
        (requestsPerMinute / 60) * (providerStats.averageResponseTime / 1000)
      );

      stats.push({
        providerId,
        load,
        health: health.status,
        requestsPerMinute,
        averageResponseTime: providerStats.averageResponseTime,
      });
    }

    return stats.sort((a, b) => a.load - b.load);
  }

  /**
   * Execute provider request with failover
   */
  public async executeWithFailover<T>(
    operation: (provider: any) => Promise<T>,
    options: {
      modelId?: string;
      requestType?: 'chat' | 'completion' | 'embedding';
      maxRetries?: number;
      timeout?: number;
    } = {}
  ): Promise<{ result: T; providerId: string; attempts: number }> {
    const { modelId, requestType = 'chat', maxRetries = 3, timeout = 30000 } = options;
    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts++;

      try {
        // Select best provider for this request
        const provider = this.getBestProviderForRequest(modelId, requestType);
        if (!provider) {
          throw new RouteCodexError('No suitable provider available', 'no_provider_available', 503);
        }

        const result = await Promise.race([
          operation(provider),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Provider request timeout')), timeout)
          ),
        ]);

        return { result, providerId: provider.getModuleInfo().id, attempts };
      } catch (error) {
        lastError = error as Error;

        // Log the attempt failure
        (this.debugEventBus as any)?.publish({
          sessionId: `session_${Date.now()}`,
          moduleId: 'provider-manager',
          operationId: 'provider_request_failed',
          timestamp: Date.now(),
          type: 'error',
          position: 'middle',
          data: {
            attempt,
            maxRetries,
            modelId,
            requestType,
            error: error instanceof Error ? error.message : String(error),
          },
        } as unknown);

        // If this isn't the last attempt, try to switch provider
        if (attempt < maxRetries) {
          try {
            await this.switchProvider();
          } catch (switchError) {
            // If provider switching fails, continue with next attempt
            console.warn('Provider switch failed:', switchError);
          }
        }
      }
    }

    // All attempts failed
    throw lastError || new Error('All provider attempts failed');
  }

  /**
   * Add provider dynamically at runtime
   */
  public async addDynamicProvider(
    providerId: string,
    config: ProviderConfig,
    options: {
      validateOnly?: boolean;
      healthCheck?: boolean;
    } = {}
  ): Promise<{ success: boolean; message?: string; health?: ProviderHealth }> {
    // Dynamic providers are disabled in pipeline-first mode
    void providerId; void config; void options;
    return { success: false, message: 'Dynamic providers are disabled (pipeline-managed providers only)' };
  }

  /**
   * Get manager metrics
   */
  public getMetrics(): UnknownObject {
    return {
      ...this.metrics,
      providerCount: this.providers.size,
      activeProviderCount: this.getActiveProviders().length,
      healthCheckInterval: this.options.healthCheckInterval,
      autoRecoveryEnabled: this.options.autoRecoveryEnabled,
      providers: this.getAllProvidersHealth(),
    };
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): UnknownObject {
    const baseStatus = {
      providerManagerId: this.getInfo().id,
      name: this.getInfo().name,
      version: this.getInfo().version,
      isInitialized: this.getStatus() !== 'stopped',
      isRunning: this.isModuleRunning(),
      status: this.getStatus(),
      providerCount: this.providers.size,
      activeProviderCount: this.getActiveProviders().length,
      healthCheckInterval: this.options.healthCheckInterval,
      autoRecoveryEnabled: this.options.autoRecoveryEnabled,
      healthMonitoringActive: this.healthCheckInterval !== null,
      isEnhanced: true,
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      providerMetrics: this.getProviderMetrics(),
      healthStats: this.getHealthStats(),
      managerMetrics: this.getManagerMetrics(),
    };
  }

  /**
   * Get provider metrics
   */
  private getProviderMetrics(): UnknownObject {
    const metrics: UnknownObject = {};

    for (const [operation, metric] of this.moduleMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5), // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Get health monitoring statistics
   */
  private getHealthStats(): UnknownObject {
    const healthChecks = this.metrics.totalHealthChecks;
    const failedChecks = this.metrics.failedHealthChecks;
    const successRate =
      healthChecks > 0 ? (((healthChecks - failedChecks) / healthChecks) * 100).toFixed(2) : 0;

    return {
      totalHealthChecks: healthChecks,
      failedHealthChecks: failedChecks,
      successRate: `${successRate}%`,
      averageRecoveryTime: this.metrics.averageRecoveryTime.toFixed(2),
      providerSwitches: this.metrics.providerSwitches,
      providersByHealth: this.getProvidersByHealthStatus(),
    };
  }

  /**
   * Get manager metrics
   */
  private getManagerMetrics(): UnknownObject {
    return {
      ...this.metrics,
      providerCount: this.providers.size,
      activeProviderCount: this.getActiveProviders().length,
      healthCheckInterval: this.options.healthCheckInterval,
      autoRecoveryEnabled: this.options.autoRecoveryEnabled,
      maxConsecutiveFailures: this.options.maxConsecutiveFailures,
      providerTimeout: this.options.providerTimeout,
      enableMetrics: this.options.enableMetrics,
    };
  }

  /**
   * Get providers grouped by health status
   */
  private getProvidersByHealthStatus(): UnknownObject {
    const status = {
      healthy: 0,
      unhealthy: 0,
      unknown: 0,
    };

    for (const [_providerId, providerInstance] of this.providers.entries()) { // eslint-disable-line @typescript-eslint/no-unused-vars
      try {
        const h = providerInstance.provider?.getHealth?.();
        const key = (h?.status === 'healthy' || h?.status === 'unhealthy' || h?.status === 'unknown') ? h.status : 'unknown';
        (status as any)[key] = ((status as any)[key] || 0) + 1;
      } catch { /* ignore */ }
    }

    return status;
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): UnknownObject {
    return {
      providerManagerId: this.getInfo().id,
      name: this.getInfo().name,
      version: this.getInfo().version,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      providerCount: this.providers.size,
      activeProviderCount: this.getActiveProviders().length,
      healthMonitoringActive: this.healthCheckInterval !== null,
      healthCheckInterval: this.options.healthCheckInterval,
      autoRecoveryEnabled: this.options.autoRecoveryEnabled,
      maxConsecutiveFailures: this.options.maxConsecutiveFailures,
      providerTimeout: this.options.providerTimeout,
      enableMetrics: this.options.enableMetrics,
      uptime: this.isModuleRunning() ? Date.now() - ((this.getStats().uptime as number) || Date.now()) : 0,
    };
  }

  /**
   * Get manager status
   */
  public getManagerStatus(): UnknownObject {
    return {
      initialized: this.isModuleRunning(),
      running: this.isModuleRunning(),
      providers: this.getAllProvidersHealth(),
      metrics: this.getMetrics(),
    };
  }

  /**
   * Reset provider state
   */
  public async resetProvider(providerId: string): Promise<void> {
    try {
      const providerInstance = this.providers.get(providerId);
      if (!providerInstance) {
        throw new Error(`Provider ${providerId} not found`);
      }

      await providerInstance.provider.reset();
      providerInstance.isActive = true;
      providerInstance.consecutiveFailures = 0;

      (this.debugEventBus as any)?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-manager',
        operationId: 'provider_reset',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
        },
      } as unknown);
    } catch (error) {
      await this.handleError(error as Error, 'reset_provider');
      throw error;
    }
  }

  /**
   * Handle error with enhanced error handling system
   */
  protected async handleError(error: Error, context: string): Promise<void> {
    try {
      // Use enhanced error handling utilities
      await this.errorUtils.handle(error, context, {
        severity: this.getErrorSeverity(context, error),
        category: this.getErrorCategory(context),
        additionalContext: {
          stack: error.stack,
          name: error.name,
          providerCount: this.providers.size,
          activeProviderCount: this.getActiveProviders().length,
          healthCheckInterval: this.options.healthCheckInterval,
          autoRecoveryEnabled: this.options.autoRecoveryEnabled,
        },
      });
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Get error severity based on context and error type
   */
  private getErrorSeverity(context: string, error: Error): 'low' | 'medium' | 'high' | 'critical' {
    const errorName = error.constructor.name;

    // Critical errors
    if (
      context.includes('initialization') ||
      context.includes('critical_provider_failure') ||
            (errorName === 'RouteCodexError' && (error as any).status >= 500)
    ) {
      return 'critical';
    }

    // High severity errors
    if (
      context.includes('config') ||
      context.includes('provider_unavailable') ||
      errorName === 'TypeError'
    ) {
      return 'high';
    }

    // Medium severity errors
    if (
      context.includes('health_check') ||
      context.includes('provider_switch') ||
      context.includes('timeout') ||
      errorName === 'RouteCodexError'
    ) {
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
      health_check: 'provider',
      provider_switch: 'provider',
      provider_unavailable: 'provider',
      config: 'configuration',
      timeout: 'performance',
      critical_provider_failure: 'provider',
    };

    for (const [key, category] of Object.entries(categories)) {
      if (context.includes(key)) {
        return category;
      }
    }
    return 'general';
  }

  /**
   * Stop provider manager
   */
  public async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Destroy all providers
    const destroyPromises = Array.from(this.providers.values()).map(async providerInstance => {
      try {
        await providerInstance.provider.destroy();
      } catch (error) {
        console.error(`Error destroying provider:`, error);
      }
    });

    await Promise.allSettled(destroyPromises);
    this.providers.clear();

    await this.errorHandling.destroy();
  }
}
