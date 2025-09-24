/**
 * RouteCodex Parallel Initializer
 *
 * Provides parallel initialization capabilities for pipeline modules with dependency resolution,
 * significantly improving startup performance and enabling efficient resource utilization.
 */

import { DebugEventBus } from 'rcc-debugcenter';
import type { DebugCenter } from '../pipeline/types/external-types.js';

/**
 * Initialization configuration
 */
export interface InitializationConfig {
  /** Maximum concurrent initialization tasks */
  maxConcurrentTasks?: number;
  /** Initialization timeout in milliseconds */
  initializationTimeout?: number;
  /** Enable dependency resolution */
  enableDependencyResolution?: boolean;
  /** Enable health checks after initialization */
  enableHealthChecks?: boolean;
  /** Enable performance tracking */
  enablePerformanceTracking?: boolean;
  /** Retry configuration for failed initialization */
  retryConfig?: {
    maxRetries?: number;
    retryDelay?: number;
    exponentialBackoff?: boolean;
  };
}

/**
 * Initialization task interface
 */
export interface InitializationTask {
  /** Task identifier */
  readonly id: string;
  /** Task name */
  readonly name: string;
  /** Task dependencies */
  readonly dependencies?: string[];
  /** Initialization function */
  readonly initialize: () => Promise<any>;
  /** Health check function (optional) */
  readonly healthCheck?: () => Promise<boolean>;
  /** Cleanup function (optional) */
  readonly cleanup?: () => Promise<void>;
  /** Task priority (lower numbers = higher priority) */
  readonly priority?: number;
  /** Task group for batching */
  readonly group?: string;
  /** Task metadata */
  readonly metadata?: Record<string, any>;
}

/**
 * Initialization result interface
 */
export interface InitializationResult {
  /** Task identifier */
  readonly taskId: string;
  /** Task name */
  readonly taskName: string;
  /** Success status */
  readonly success: boolean;
  /** Initialization duration in milliseconds */
  readonly duration: number;
  /** Result data */
  readonly result?: any;
  /** Error information (if failed) */
  readonly error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  /** Retry attempts */
  readonly retryAttempts: number;
  /** Dependencies resolved */
  readonly dependenciesResolved: string[];
  /** Health check status */
  readonly healthCheckStatus?: 'passed' | 'failed' | 'skipped';
  /** Performance metrics */
  readonly performance?: {
    memoryUsage?: number;
    cpuTime?: number;
    networkCalls?: number;
  };
}

/**
 * Initialization statistics
 */
export interface InitializationStatistics {
  /** Total tasks to initialize */
  totalTasks: number;
  /** Successfully initialized tasks */
  successfulTasks: number;
  /** Failed tasks */
  failedTasks: number;
  /** Total initialization duration */
  totalDuration: number;
  /** Average initialization time per task */
  averageInitializationTime: number;
  /** Longest initialization time */
  longestInitializationTime: number;
  /** Shortest initialization time */
  shortestInitializationTime: number;
  /** Concurrency utilization */
  concurrencyUtilization: number;
  /** Memory usage peak */
  peakMemoryUsage?: number;
  /** Retry statistics */
  retryStats: {
    totalRetries: number;
    successfulRetries: number;
    failedRetries: number;
  };
}

/**
 * Task dependency graph
 */
export interface DependencyGraph {
  /** All tasks */
  tasks: Map<string, InitializationTask>;
  /** Dependency adjacency list */
  dependencies: Map<string, Set<string>>;
  /** Reverse dependencies */
  reverseDependencies: Map<string, Set<string>>;
  /** Topological order */
  topologicalOrder: string[];
}

/**
 * Parallel Initializer
 *
 * Provides sophisticated parallel initialization capabilities with dependency resolution,
 * retry mechanisms, health monitoring, and comprehensive performance tracking.
 */
export class ParallelInitializer {
  private debugCenter: DebugCenter;
  private eventBus: DebugEventBus;
  private config: InitializationConfig;
  private isInitialized = false;

  // Task management
  private tasks: Map<string, InitializationTask> = new Map();
  private results: Map<string, InitializationResult> = new Map();
  private runningTasks: Set<string> = new Set();
  private completedTasks: Set<string> = new Set();
  private failedTasks: Set<string> = new Set();

  // Performance tracking
  private performanceMetrics: Map<string, any> = new Map();
  private initializationHistory: any[] = [];

  // Dependency management
  private dependencyGraph: DependencyGraph | null = null;

  /**
   * Constructor
   */
  constructor(debugCenter: DebugCenter, config: InitializationConfig = {}) {
    this.debugCenter = debugCenter;
    this.eventBus = DebugEventBus.getInstance();
    this.config = {
      maxConcurrentTasks: 4,
      initializationTimeout: 30000,
      enableDependencyResolution: true,
      enableHealthChecks: true,
      enablePerformanceTracking: true,
      retryConfig: {
        maxRetries: 3,
        retryDelay: 1000,
        exponentialBackoff: true
      },
      ...config
    };
  }

  /**
   * Register initialization task
   */
  registerTask(task: InitializationTask): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task with ID ${task.id} is already registered`);
    }

    this.tasks.set(task.id, task);
    this.log('info', `Registered initialization task: ${task.name} (${task.id})`);
  }

  /**
   * Register multiple initialization tasks
   */
  registerTasks(tasks: InitializationTask[]): void {
    for (const task of tasks) {
      this.registerTask(task);
    }
  }

  /**
   * Remove initialization task
   */
  removeTask(taskId: string): boolean {
    const removed = this.tasks.delete(taskId);
    if (removed) {
      this.log('info', `Removed initialization task: ${taskId}`);
    }
    return removed;
  }

  /**
   * Initialize all registered tasks in parallel
   */
  async initializeAll(): Promise<Map<string, InitializationResult>> {
    if (this.isInitialized) {
      this.log('warn', 'Initializer is already initialized');
      return this.results;
    }

    const startTime = Date.now();

    try {
      this.log('info', `Starting parallel initialization of ${this.tasks.size} tasks`);

      // Build dependency graph if enabled
      if (this.config.enableDependencyResolution!) {
        this.dependencyGraph = this.buildDependencyGraph();
      }

      // Group tasks by dependencies
      const taskGroups = this.groupTasksByDependencies();

      // Initialize task groups in parallel
      for (const group of taskGroups) {
        await this.initializeTaskGroup(group);
      }

      // Perform health checks if enabled
      if (this.config.enableHealthChecks!) {
        await this.performHealthChecks();
      }

      this.isInitialized = true;
      const totalDuration = Date.now() - startTime;

      this.log('info', `Parallel initialization completed in ${totalDuration}ms`);
      this.recordInitializationStatistics(totalDuration);

      return new Map(this.results);
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      this.log('error', `Parallel initialization failed after ${totalDuration}ms`, error);
      throw error;
    }
  }

  /**
   * Initialize specific task
   */
  async initializeTask(taskId: string): Promise<InitializationResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (this.results.has(taskId)) {
      return this.results.get(taskId)!;
    }

    const startTime = Date.now();
    let result: InitializationResult;

    try {
      this.log('info', `Initializing task: ${task.name} (${taskId})`);
      this.runningTasks.add(taskId);

      // Execute with retry logic
      const retryResult = await this.executeWithRetry(task);
      const duration = Date.now() - startTime;

      result = {
        taskId: task.id,
        taskName: task.name,
        success: true,
        duration,
        result: retryResult.result,
        retryAttempts: retryResult.attempts,
        dependenciesResolved: this.getResolvedDependencies(taskId),
        healthCheckStatus: 'skipped',
        performance: this.collectPerformanceMetrics(taskId, duration)
      };

      this.results.set(taskId, result);
      this.completedTasks.add(taskId);
      this.runningTasks.delete(taskId);

      this.log('info', `Task ${task.name} initialized successfully in ${duration}ms`);

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorObj = error instanceof Error ? error : new Error(String(error));

      result = {
        taskId: task.id,
        taskName: task.name,
        success: false,
        duration,
        error: {
          message: errorObj.message,
          stack: errorObj.stack,
          code: (errorObj as any).code
        },
        retryAttempts: this.config.retryConfig!.maxRetries!,
        dependenciesResolved: this.getResolvedDependencies(taskId),
        healthCheckStatus: 'skipped',
        performance: this.collectPerformanceMetrics(taskId, duration)
      };

      this.results.set(taskId, result);
      this.failedTasks.add(taskId);
      this.runningTasks.delete(taskId);

      this.log('error', `Task ${task.name} initialization failed after ${duration}ms`, error);
    }

    return result;
  }

  /**
   * Get initialization results
   */
  getResults(): Map<string, InitializationResult> {
    return new Map(this.results);
  }

  /**
   * Get initialization statistics
   */
  getStatistics(): InitializationStatistics {
    const durations = Array.from(this.results.values()).map(r => r.duration);
    const totalTasks = this.tasks.size;
    const successfulTasks = this.completedTasks.size;
    const failedTasks = this.failedTasks.size;
    const totalDuration = Math.max(...durations, 0);
    const averageTime = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const longestTime = durations.length > 0 ? Math.max(...durations) : 0;
    const shortestTime = durations.length > 0 ? Math.min(...durations) : 0;

    // Calculate retry statistics
    const totalRetries = Array.from(this.results.values()).reduce((sum, r) => sum + r.retryAttempts, 0);
    const successfulRetries = Array.from(this.results.values())
      .filter(r => r.success && r.retryAttempts > 0)
      .reduce((sum, r) => sum + r.retryAttempts, 0);
    const failedRetries = totalRetries - successfulRetries;

    return {
      totalTasks,
      successfulTasks,
      failedTasks,
      totalDuration,
      averageInitializationTime: averageTime,
      longestInitializationTime: longestTime,
      shortestInitializationTime: shortestTime,
      concurrencyUtilization: this.calculateConcurrencyUtilization(),
      peakMemoryUsage: this.getPeakMemoryUsage(),
      retryStats: {
        totalRetries,
        successfulRetries,
        failedRetries
      }
    };
  }

  /**
   * Get system initialization status
   */
  getSystemStatus(): any {
    const stats = this.getStatistics();
    const tasks: any = {};

    for (const [id, result] of this.results) {
      const task = this.tasks.get(id)!;
      tasks[id] = {
        id: result.taskId,
        name: result.taskName,
        status: result.success ? 'success' : 'failed',
        duration: result.duration,
        retryAttempts: result.retryAttempts,
        priority: task.priority || 0,
        group: task.group || 'default',
        healthCheckStatus: result.healthCheckStatus
      };
    }

    return {
      initializerId: 'ParallelInitializer',
      version: '1.0.0',
      isInitialized: this.isInitialized,
      config: this.config,
      statistics: stats,
      runningTasks: Array.from(this.runningTasks),
      completedTasks: Array.from(this.completedTasks),
      failedTasks: Array.from(this.failedTasks),
      tasks,
      timestamp: Date.now()
    };
  }

  /**
   * Reset the initializer
   */
  reset(): void {
    this.results.clear();
    this.runningTasks.clear();
    this.completedTasks.clear();
    this.failedTasks.clear();
    this.performanceMetrics.clear();
    this.initializationHistory.length = 0;
    this.dependencyGraph = null;
    this.isInitialized = false;

    this.log('info', 'ParallelInitializer reset');
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    try {
      // Execute cleanup functions for all tasks
      const cleanupPromises = Array.from(this.tasks.values()).map(async task => {
        if (task.cleanup) {
          try {
            await task.cleanup();
          } catch (error) {
            this.log('warn', `Cleanup failed for task ${task.name}`, error);
          }
        }
      });

      await Promise.allSettled(cleanupPromises);
      this.reset();

      this.log('info', 'ParallelInitializer cleanup completed');
    } catch (error) {
      this.log('error', 'Failed to cleanup ParallelInitializer', error);
      throw error;
    }
  }

  /**
   * Build dependency graph
   */
  private buildDependencyGraph(): DependencyGraph {
    const tasks = new Map(this.tasks);
    const dependencies = new Map<string, Set<string>>();
    const reverseDependencies = new Map<string, Set<string>>();

    // Build adjacency lists
    for (const task of tasks.values()) {
      const taskDeps = task.dependencies || [];
      dependencies.set(task.id, new Set(taskDeps));

      // Build reverse dependencies
      for (const dep of taskDeps) {
        if (!reverseDependencies.has(dep)) {
          reverseDependencies.set(dep, new Set());
        }
        reverseDependencies.get(dep)!.add(task.id);
      }
    }

    // Perform topological sort
    const topologicalOrder = this.topologicalSort(tasks, dependencies);

    return {
      tasks,
      dependencies,
      reverseDependencies,
      topologicalOrder
    };
  }

  /**
   * Topological sort using Kahn's algorithm
   */
  private topologicalSort(tasks: Map<string, InitializationTask>, dependencies: Map<string, Set<string>>): string[] {
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const result: string[] = [];

    // Calculate in-degrees
    for (const taskId of tasks.keys()) {
      inDegree.set(taskId, 0);
    }

    for (const [taskId, deps] of dependencies) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      }
    }

    // Find nodes with no incoming edges
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(taskId);
      }
    }

    // Process nodes
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // Decrement in-degree for neighbors
      const neighbors = dependencies.get(current) || new Set();
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    // Check for cycles
    if (result.length !== tasks.size) {
      throw new Error('Circular dependency detected in initialization tasks');
    }

    return result;
  }

  /**
   * Group tasks by dependencies
   */
  private groupTasksByDependencies(): InitializationTask[][] {
    if (!this.dependencyGraph) {
      // No dependency resolution, return all tasks in one group
      return [Array.from(this.tasks.values())];
    }

    const groups: InitializationTask[][] = [];
    const processed = new Set<string>();
    const topologicalOrder = this.dependencyGraph.topologicalOrder;

    // Group tasks that can run in parallel
    while (processed.size < topologicalOrder.length) {
      const currentGroup: InitializationTask[] = [];

      for (const taskId of topologicalOrder) {
        if (processed.has(taskId)) continue;

        const task = this.tasks.get(taskId)!;
        const dependencies = task.dependencies || [];

        // Check if all dependencies are processed
        const allDependenciesProcessed = dependencies.every(dep => processed.has(dep));

        if (allDependenciesProcessed) {
          currentGroup.push(task);
        }
      }

      if (currentGroup.length === 0) {
        throw new Error('Unable to resolve task dependencies - possible circular dependency');
      }

      // Sort by priority
      currentGroup.sort((a, b) => (a.priority || 0) - (b.priority || 0));

      groups.push(currentGroup);
      currentGroup.forEach(task => processed.add(task.id));
    }

    return groups;
  }

  /**
   * Initialize task group with concurrency limit
   */
  private async initializeTaskGroup(tasks: InitializationTask[]): Promise<void> {
    const maxConcurrent = this.config.maxConcurrentTasks!;
    const chunks = this.chunkArray(tasks, maxConcurrent);

    for (const chunk of chunks) {
      const promises = chunk.map(task => this.initializeTask(task.id));
      await Promise.allSettled(promises);
    }
  }

  /**
   * Execute task with retry logic
   */
  private async executeWithRetry(task: InitializationTask): Promise<{ result: any; attempts: number }> {
    const maxRetries = this.config.retryConfig!.maxRetries!;
    const baseDelay = this.config.retryConfig!.retryDelay!;
    const exponentialBackoff = this.config.retryConfig!.exponentialBackoff!;

    let lastError: any;
    let attempts = 0;

    for (let i = 0; i <= maxRetries; i++) {
      attempts++;
      try {
        const result = await Promise.race([
          task.initialize(),
          this.createTimeoutPromise(this.config.initializationTimeout!)
        ]);

        return { result, attempts };
      } catch (error) {
        lastError = error;

        if (i < maxRetries) {
          const delay = exponentialBackoff ? baseDelay * Math.pow(2, i) : baseDelay;
          this.log('warn', `Task ${task.name} failed, retrying in ${delay}ms (attempt ${i + 1}/${maxRetries})`, error);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Perform health checks on all successfully initialized tasks
   */
  private async performHealthChecks(): Promise<void> {
    const healthCheckPromises = Array.from(this.results.values())
      .filter(result => result.success)
      .map(async result => {
        const task = this.tasks.get(result.taskId)!;
        if (task.healthCheck) {
          try {
            const isHealthy = await task.healthCheck();
            // Update the result in the Map with health check status
            this.results.set(result.taskId, {
              ...result,
              healthCheckStatus: isHealthy ? 'passed' : 'failed'
            });

            if (!isHealthy) {
              this.log('warn', `Health check failed for task ${task.name}`);
            }
          } catch (error) {
            // Update the result in the Map with health check status
            this.results.set(result.taskId, {
              ...result,
              healthCheckStatus: 'failed'
            });
            this.log('warn', `Health check error for task ${task.name}`, error);
          }
        }
      });

    await Promise.allSettled(healthCheckPromises);
  }

  /**
   * Get resolved dependencies for a task
   */
  private getResolvedDependencies(taskId: string): string[] {
    const task = this.tasks.get(taskId)!;
    const dependencies = task.dependencies || [];
    return dependencies.filter(dep => this.completedTasks.has(dep));
  }

  /**
   * Collect performance metrics for a task
   */
  private collectPerformanceMetrics(taskId: string, duration: number): any {
    if (!this.config.enablePerformanceTracking!) {
      return undefined;
    }

    const memoryUsage = process.memoryUsage();
    return {
      memoryUsage: memoryUsage.heapUsed,
      cpuTime: duration,
      networkCalls: 0 // Would be tracked in real implementation
    };
  }

  /**
   * Calculate concurrency utilization
   */
  private calculateConcurrencyUtilization(): number {
    const maxConcurrent = this.config.maxConcurrentTasks || 1;
    const avgRunningTasks = this.initializationHistory.length > 0
      ? this.initializationHistory.reduce((sum, h) => sum + h.runningTasks, 0) / this.initializationHistory.length
      : 0;

    return Math.min(avgRunningTasks / maxConcurrent, 1);
  }

  /**
   * Get peak memory usage
   */
  private getPeakMemoryUsage(): number {
    if (!this.config.enablePerformanceTracking) {
      return 0;
    }

    return Array.from(this.results.values())
      .map(r => r.performance?.memoryUsage || 0)
      .reduce((max, usage) => Math.max(max, usage), 0) || 0;
  }

  /**
   * Record initialization statistics
   */
  private recordInitializationStatistics(totalDuration: number): void {
    this.initializationHistory.push({
      timestamp: Date.now(),
      totalDuration,
      totalTasks: this.tasks.size,
      successfulTasks: this.completedTasks.size,
      failedTasks: this.failedTasks.size,
      runningTasks: this.runningTasks.size
    });

    // Keep only last 100 initialization records
    if (this.initializationHistory.length > 100) {
      this.initializationHistory.shift();
    }

    // Publish completion event
    this.eventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'ParallelInitializer',
      operationId: 'initialization_completed',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        totalDuration,
        totalTasks: this.tasks.size,
        successfulTasks: this.completedTasks.size,
        failedTasks: this.failedTasks.size,
        statistics: this.getStatistics()
      }
    });
  }

  /**
   * Create timeout promise
   */
  private createTimeoutPromise(timeout: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Initialization timeout')), timeout);
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Internal logging method
   */
  private log(level: 'info' | 'warn' | 'error', message: string, error?: any): void {
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      component: 'ParallelInitializer',
      error: error ? error.message || String(error) : undefined
    };

    // Publish to debug event bus
    this.eventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'ParallelInitializer',
      operationId: 'log_message',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: logEntry
    });

    // Console output for critical messages
    if (level === 'error' || process.env.NODE_ENV === 'development') {
      console.log(`[ParallelInitializer] ${level.toUpperCase()}: ${message}`, error || '');
    }
  }
}