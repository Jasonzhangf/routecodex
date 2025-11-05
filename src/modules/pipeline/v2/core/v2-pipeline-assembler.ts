/**
 * V2 Pipeline Assembler
 *
 * Validates configuration and pre-run flow for V2 architecture.
 * Ensures all modules are loaded and routes are validated before switching.
 */

import type { V2SystemConfig, RouteDefinition, ValidationResult, PipelineRequest, ModuleSpecification, ModuleConfig } from '../types/v2-types.js';
import type { StaticInstancePool, InstancePoolMetrics } from './static-instance-pool.js';
import type { DynamicRouter, RouterMetrics } from './dynamic-router.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Pre-run Report
 */
export interface PreRunReport {
  startTime: number;
  endTime?: number;
  duration?: number;
  totalRoutes: number;
  successfulRoutes: number;
  failedRoutes: Array<{
    routeId: string;
    error: string;
    recoverable: boolean;
  }>;
  warnings: string[];
  success: boolean;
}

/**
 * V2 Pipeline Assembler
 *
 * Validates V2 configuration and pre-run flow.
 * Ensures all required instances are loaded and routes are functional.
 */
export class V2PipelineAssembler {
  private readonly logger: PipelineDebugLogger;
  private readonly instancePool: StaticInstancePool;
  private readonly router: DynamicRouter;

  constructor(
    instancePool: StaticInstancePool,
    router: DynamicRouter,
    logger?: PipelineDebugLogger
  ) {
    this.instancePool = instancePool;
    this.router = router;
    this.logger = logger || new PipelineDebugLogger();
  }

  /**
   * Validate V2 system configuration
   */
  async validateConfiguration(v2Config: V2SystemConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    this.logger.logModule('v2-assembler', 'validation-start');

    // 1. Validate system configuration
    const systemValidation = this.validateSystemConfig(v2Config.system);
    errors.push(...systemValidation.errors);
    warnings.push(...systemValidation.warnings || []);

    // 2. Validate static instances configuration
    const instancesValidation = this.validateStaticInstancesConfig(v2Config.staticInstances);
    errors.push(...instancesValidation.errors);
    warnings.push(...instancesValidation.warnings || []);

    // 3. Validate virtual pipelines configuration
    const pipelinesValidation = this.validateVirtualPipelinesConfig(v2Config.virtualPipelines);
    errors.push(...pipelinesValidation.errors);
    warnings.push(...pipelinesValidation.warnings || []);

    // 4. Validate module registry configuration
    const registryValidation = this.validateModuleRegistryConfig(v2Config.virtualPipelines.moduleRegistry);
    errors.push(...registryValidation.errors);
    warnings.push(...registryValidation.warnings || []);

    // 5. Cross-validate route dependencies
    const dependencyValidation = this.validateRouteDependencies(v2Config);
    errors.push(...dependencyValidation.errors);
    warnings.push(...dependencyValidation.warnings || []);

    const result = {
      isValid: errors.length === 0,
      errors,
      warnings
    };

    this.logger.logModule('v2-assembler', 'validation-complete', {
      isValid: result.isValid,
      errorCount: errors.length,
      warningCount: warnings.length
    });

    return result;
  }

  /**
   * Execute pre-run validation
   */
  async executePreRun(v2Config: V2SystemConfig): Promise<PreRunReport> {
    const report: PreRunReport = {
      startTime: Date.now(),
      totalRoutes: 0,
      successfulRoutes: 0,
      failedRoutes: [],
      warnings: [],
      success: false
    };

    this.logger.logModule('v2-assembler', 'pre-run-start');

    try {
      // 1. Validate configuration
      const configValidation = await this.validateConfiguration(v2Config);
      if (!configValidation.isValid) {
        report.failedRoutes.push({
          routeId: 'configuration',
          error: `Configuration validation failed: ${configValidation.errors.join(', ')}`,
          recoverable: false
        });
        throw new Error(`Configuration validation failed: ${configValidation.errors.join(', ')}`);
      }

      report.warnings.push(...(configValidation.warnings || []));

      // 2. Preload instances
      const warmupReport = await this.instancePool.preloadInstances(v2Config);
      if (!warmupReport.success) {
        report.failedRoutes.push(...warmupReport.failedInstances.map(instance => ({
          routeId: `instance-${instance.module}`,
          error: instance.error,
          recoverable: instance.recoverable
        })));
        throw new Error('Instance preloading failed');
      }

      report.warnings.push(...warmupReport.warnings);

      // 3. Validate routes
      const routeValidation = await this.validateRoutes(v2Config);
      report.totalRoutes = routeValidation.totalRoutes;
      report.successfulRoutes = routeValidation.successfulRoutes;
      report.failedRoutes.push(...routeValidation.failedRoutes);
      report.warnings.push(...routeValidation.warnings);

      // 4. Validate router configuration
      const routerValidation = this.router.validate();
      if (!routerValidation.isValid) {
        report.failedRoutes.push({
          routeId: 'router',
          error: `Router validation failed: ${routerValidation.errors.join(', ')}`,
          recoverable: false
        });
        throw new Error(`Router validation failed: ${routerValidation.errors.join(', ')}`);
      }

      report.warnings.push(...(routerValidation.warnings || []));

      report.success = report.failedRoutes.length === 0;

      this.logger.logModule('v2-assembler', 'pre-run-success', {
        duration: Date.now() - report.startTime,
        totalRoutes: report.totalRoutes,
        successfulRoutes: report.successfulRoutes,
        failedRoutes: report.failedRoutes.length
      });

    } catch (error) {
      report.success = false;
      report.failedRoutes.push({
        routeId: 'pre-run',
        error: error instanceof Error ? error.message : String(error),
        recoverable: false
      });

      this.logger.logModule('v2-assembler', 'pre-run-error', {
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - report.startTime
      });
    }

    report.endTime = Date.now();
    report.duration = report.endTime - report.startTime;

    return report;
  }

  /**
   * Simulate data flow for all routes
   */
  async simulateDataFlow(v2Config: V2SystemConfig): Promise<{
    success: boolean;
    results: Array<{
      routeId: string;
      success: boolean;
      error?: string;
      duration: number;
    }>;
  }> {
    const results: Array<{
      routeId: string;
      success: boolean;
      error?: string;
      duration: number;
    }> = [];

    this.logger.logModule('v2-assembler', 'simulation-start');

    for (const route of v2Config.virtualPipelines.routeTable.routes) {
      const startTime = Date.now();

      try {
        // Create mock request
        const mockRequest = this.createMockRequest(route);

        // Route simulation
        const routingResult = this.router.matchRoute(mockRequest);
        if (!routingResult) {
          results.push({
            routeId: route.id,
            success: false,
            error: 'No routing match found',
            duration: Date.now() - startTime
          });
          continue;
        }

        // Build chain simulation
        const chain = await this.router.buildModuleChain(routingResult.route, mockRequest);
        if (!chain) {
          results.push({
            routeId: route.id,
            success: false,
            error: 'Failed to build module chain',
            duration: Date.now() - startTime
          });
          continue;
        }

        // Validate chain health
        const healthValidation = chain.validateHealth();
        if (!healthValidation.isValid) {
          results.push({
            routeId: route.id,
            success: false,
            error: `Chain validation failed: ${healthValidation.errors.join(', ')}`,
            duration: Date.now() - startTime
          });
          continue;
        }

        results.push({
          routeId: route.id,
          success: true,
          duration: Date.now() - startTime
        });

        // Cleanup simulated chain
        await chain.cleanupConnections();

      } catch (error) {
        results.push({
          routeId: route.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime
        });
      }
    }

    const success = results.every(r => r.success);

    this.logger.logModule('v2-assembler', 'simulation-complete', {
      totalRoutes: results.length,
      successfulRoutes: results.filter(r => r.success).length,
      failedRoutes: results.filter(r => !r.success).length
    });

    return { success, results };
  }

  /**
   * Get assembly status
   */
  getAssemblyStatus(): {
    isAssembled: boolean;
    instancePoolMetrics: InstancePoolMetrics;
    routerMetrics: RouterMetrics;
    lastValidation?: ValidationResult;
    lastPreRun?: PreRunReport;
  } {
    return {
      isAssembled: true, // Basic implementation
      instancePoolMetrics: this.instancePool.getMetrics(),
      routerMetrics: this.router.getMetrics()
    };
  }

  /**
   * Validate system configuration
   */
  private validateSystemConfig(system: V2SystemConfig['system']): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate mode
    if (!['v1', 'v2', 'hybrid'].includes(system.mode)) {
      errors.push(`Invalid system mode: ${system.mode}. Must be 'v1', 'v2', or 'hybrid'`);
    }

    // Validate dry run setting
    if (typeof system.enableDryRun !== 'boolean') {
      errors.push('enableDryRun must be a boolean');
    }

    // Validate feature flags
    if (!system.featureFlags || typeof system.featureFlags !== 'object') {
      errors.push('featureFlags must be an object');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate static instances configuration
   */
  private validateStaticInstancesConfig(staticInstances: V2SystemConfig['staticInstances']): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate preload modules
    if (!Array.isArray(staticInstances.preloadModules)) {
      errors.push('preloadModules must be an array');
    }

    // Validate pool configuration
    if (!staticInstances.poolConfig) {
      errors.push('poolConfig is required');
    } else {
      const { poolConfig } = staticInstances;

      if (typeof poolConfig.maxInstancesPerType !== 'number' || poolConfig.maxInstancesPerType <= 0) {
        errors.push('poolConfig.maxInstancesPerType must be a positive number');
      }

      if (typeof poolConfig.warmupInstances !== 'number' || poolConfig.warmupInstances < 0) {
        errors.push('poolConfig.warmupInstances must be a non-negative number');
      }

      if (typeof poolConfig.idleTimeout !== 'number' || poolConfig.idleTimeout < 0) {
        errors.push('poolConfig.idleTimeout must be a non-negative number');
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate virtual pipelines configuration
   */
  private validateVirtualPipelinesConfig(virtualPipelines: V2SystemConfig['virtualPipelines']): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate route table
    if (!virtualPipelines.routeTable) {
      errors.push('routeTable is required');
    } else {
      const routeTableValidation = this.validateRouteTableConfig(virtualPipelines.routeTable);
      errors.push(...routeTableValidation.errors);
      warnings.push(...routeTableValidation.warnings || []);
    }

    // Validate module registry
    if (!virtualPipelines.moduleRegistry) {
      errors.push('moduleRegistry is required');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate route table configuration
   */
  private validateRouteTableConfig(routeTable: V2SystemConfig['virtualPipelines']['routeTable']): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate routes
    if (!Array.isArray(routeTable.routes)) {
      errors.push('routes must be an array');
    } else {
      for (const route of routeTable.routes) {
        const routeValidation = this.validateRouteDefinition(route);
        errors.push(...routeValidation.errors);
        warnings.push(...routeValidation.warnings || []);
      }
    }

    // Validate default route
    if (routeTable.defaultRoute && typeof routeTable.defaultRoute !== 'string') {
      errors.push('defaultRoute must be a string');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate route definition
   */
  private validateRouteDefinition(route: RouteDefinition): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!route.id || typeof route.id !== 'string') {
      errors.push('route.id is required and must be a string');
    }

    if (!route.pattern) {
      errors.push('route.pattern is required');
    }

    if (!Array.isArray(route.modules) || route.modules.length === 0) {
      errors.push('route.modules must be a non-empty array');
    }

    // Validate modules
    if (route.modules) {
      for (let i = 0; i < route.modules.length; i++) {
        const module = route.modules[i];
        if (!module.type || typeof module.type !== 'string') {
          errors.push(`route.modules[${i}].type is required and must be a string`);
        }

        // Validate condition if present
        if (module.condition) {
          if (!module.condition.field || typeof module.condition.field !== 'string') {
            errors.push(`route.modules[${i}].condition.field is required and must be a string`);
          }

          if (!['equals', 'contains', 'matches', 'exists', 'gt', 'lt'].includes(module.condition.operator)) {
            errors.push(`route.modules[${i}].condition.operator is invalid`);
          }
        }
      }
    }

    // Validate priority
    if (typeof route.priority !== 'number' || route.priority < 0) {
      errors.push('route.priority must be a non-negative number');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate module registry configuration
   */
  private validateModuleRegistryConfig(moduleRegistry: V2SystemConfig['virtualPipelines']['moduleRegistry']): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate providers
    if (!moduleRegistry.providers || typeof moduleRegistry.providers !== 'object') {
      errors.push('moduleRegistry.providers is required and must be an object');
    }

    // Validate compatibility
    if (!moduleRegistry.compatibility || typeof moduleRegistry.compatibility !== 'object') {
      errors.push('moduleRegistry.compatibility is required and must be an object');
    }

    // Validate llmSwitch
    if (!moduleRegistry.llmSwitch || typeof moduleRegistry.llmSwitch !== 'object') {
      errors.push('moduleRegistry.llmSwitch is required and must be an object');
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate route dependencies
   */
  private validateRouteDependencies(v2Config: V2SystemConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const { routeTable, moduleRegistry } = v2Config.virtualPipelines;

    for (const route of routeTable.routes) {
      for (const module of route.modules) {
        // Check if module type exists in registry
        const hasProvider = moduleRegistry.providers[module.type];
        const hasCompatibility = moduleRegistry.compatibility[module.type];
        const hasLLMSwitch = moduleRegistry.llmSwitch[module.type];

        if (!hasProvider && !hasCompatibility && !hasLLMSwitch) {
          errors.push(`Route ${route.id}: Module type '${module.type}' not found in module registry`);
        }
      }
    }

    // Check Tools Unique Entrance: llmswitch must be last module
    for (const route of routeTable.routes) {
      const lastModule = route.modules[route.modules.length - 1];
      if (!lastModule.type.toLowerCase().includes('llmswitch')) {
        errors.push(`Route ${route.id} violates Tools Unique Entrance: llmswitch must be the last module`);
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate routes
   */
  private async validateRoutes(v2Config: V2SystemConfig): Promise<{
    totalRoutes: number;
    successfulRoutes: number;
    failedRoutes: PreRunReport['failedRoutes'];
    warnings: string[];
  }> {
    const totalRoutes = v2Config.virtualPipelines.routeTable.routes.length;
    let successfulRoutes = 0;
    const failedRoutes: PreRunReport['failedRoutes'] = [];
    const warnings: string[] = [];

    for (const route of v2Config.virtualPipelines.routeTable.routes) {
      try {
        // Check if all required instances are available
        const missingInstances: string[] = [];
        let allInstancesAvailable = true;

        for (const moduleSpec of route.modules) {
          const config = this.resolveModuleConfig(moduleSpec, v2Config);
          if (!this.instancePool.hasInstance(moduleSpec.type, config)) {
            allInstancesAvailable = false;
            missingInstances.push(moduleSpec.type);
          }
        }

        if (!allInstancesAvailable) {
          failedRoutes.push({
            routeId: route.id,
            error: `Missing instances: ${missingInstances.join(', ')}`,
            recoverable: true
          });
          continue;
        }

        // Validate route pattern
        const mockRequest = this.createMockRequest(route);
        const routingResult = this.router.matchRoute(mockRequest);
        if (!routingResult) {
          failedRoutes.push({
            routeId: route.id,
            error: 'Route pattern does not match mock request',
            recoverable: true
          });
          continue;
        }

        successfulRoutes++;

      } catch (error) {
        failedRoutes.push({
          routeId: route.id,
          error: error instanceof Error ? error.message : String(error),
          recoverable: false
        });
      }
    }

    return { totalRoutes, successfulRoutes, failedRoutes, warnings };
  }

  /**
   * Create mock request for route testing
   */
  private createMockRequest(route: RouteDefinition): PipelineRequest {
    const mockRequest: PipelineRequest = {
      id: `mock-${Date.now()}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {},
      metadata: { timestamp: Date.now() }
    };

    // Add model based on pattern
    if (route.pattern.model) {
      if (typeof route.pattern.model === 'string') {
        (mockRequest.body as Record<string, unknown>).model = route.pattern.model;
      } else if (route.pattern.model instanceof RegExp) {
        (mockRequest.body as Record<string, unknown>).model = 'test-model'; // Simple test model
      }
    }

    // Add tools if pattern requires
    if (route.pattern.hasTools) {
      (mockRequest.body as Record<string, unknown>).tools = [{ type: 'function', function: { name: 'test' } }];
    }

    return mockRequest;
  }

  /**
   * Resolve module configuration
   */
  private resolveModuleConfig(moduleSpec: ModuleSpecification, _v2Config: V2SystemConfig): ModuleConfig {
    if (typeof moduleSpec.config === 'string') {
      // Reference to predefined config - simplified implementation
      return {
        type: moduleSpec.config,
        config: {}
      };
    }
    return (moduleSpec.config || { type: 'unknown', config: {} }) as ModuleConfig;
  }
}
