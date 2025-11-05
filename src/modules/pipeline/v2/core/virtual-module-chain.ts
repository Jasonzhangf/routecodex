/**
 * Virtual Module Chain
 *
 * Represents a temporary connection between static module instances.
 * Provides ephemeral processing without persistent state.
 */

import type { V2ModuleInstance } from './module-registry.js';
import type { PipelineRequest, PipelineResponse, ValidationResult, RequestContext } from '../types/v2-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Instance Connection between two modules
 */
export class InstanceConnection {
  private isConnectedFlag = false;
  private establishedAt?: number;
  private latency = 0;
  private errorCount = 0;
  private totalRequests = 0;

  constructor(
    public readonly from: V2ModuleInstance,
    public readonly to: V2ModuleInstance,
    public readonly options: {
      connectionId: string;
      temporary: boolean;
      metadata: Record<string, unknown>;
    }
  ) {}

  /**
   * Establish connection between modules
   */
  async onConnect(): Promise<void> {
    const startTime = Date.now();

    try {
      // Set up output target
      const fromConnectable = this.from as unknown as Partial<{
        setOutputTarget: (to: V2ModuleInstance) => void;
        onConnected: (peer: V2ModuleInstance) => Promise<void> | void;
        clearOutputTarget: () => void;
      }>;
      if (fromConnectable.setOutputTarget) {
        fromConnectable.setOutputTarget(this.to);
      }

      // Set up input source
      const toConnectable = this.to as unknown as Partial<{
        setInputSource: (from: V2ModuleInstance) => void;
        onConnected: (peer: V2ModuleInstance) => Promise<void> | void;
        clearInputSource: () => void;
      }>;
      if (toConnectable.setInputSource) {
        toConnectable.setInputSource(this.from);
      }

      // Trigger connection callbacks
      if (fromConnectable.onConnected) {
        await fromConnectable.onConnected(this.to);
      }
      if (toConnectable.onConnected) {
        await toConnectable.onConnected(this.from);
      }

      this.isConnectedFlag = true;
      this.establishedAt = Date.now();
      this.latency = this.establishedAt - startTime;

    } catch (error) {
      throw new Error(`Failed to establish connection ${this.options.connectionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Transform data through connection
   */
  async transform(data: unknown): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error(`Connection ${this.options.connectionId} is not established`);
    }

    const startTime = Date.now();
    this.totalRequests++;

    try {
      // Lightweight data transformation
      const result = await this.to.processIncoming(data, {
        moduleId: this.to.id,
        connectionId: this.options.connectionId,
        fromModule: this.from.id,
        toModule: this.to.id,
        ephemeral: true
      } as RequestContext);

      // Update metrics
      this.latency = Date.now() - startTime;

      return result;

    } catch (error) {
      this.errorCount++;
      throw error;
    }
  }

  /**
   * Disconnect connection
   */
  async onDisconnect(): Promise<void> {
    if (!this.isConnectedFlag) {
      return;
    }

    try {
      // Clear output target
      const fromConnectable = this.from as unknown as Partial<{ clearOutputTarget: () => void; onDisconnected: (peer: V2ModuleInstance) => Promise<void> | void }>;
      if (fromConnectable.clearOutputTarget) {
        fromConnectable.clearOutputTarget();
      }

      // Clear input source
      const toConnectable = this.to as unknown as Partial<{ clearInputSource: () => void; onDisconnected: (peer: V2ModuleInstance) => Promise<void> | void }>;
      if (toConnectable.clearInputSource) {
        toConnectable.clearInputSource();
      }

      // Trigger disconnection callbacks
      if (fromConnectable.onDisconnected) {
        await fromConnectable.onDisconnected(this.to);
      }
      if (toConnectable.onDisconnected) {
        await toConnectable.onDisconnected(this.from);
      }

    } catch (error) {
      // Log error but don't fail disconnect
      console.error(`Error during disconnect of ${this.options.connectionId}:`, error instanceof Error ? error.message : String(error));
    } finally {
      this.isConnectedFlag = false;
    }
  }

  /**
   * Check if connection is healthy
   */
  isConnected(): boolean {
    return this.isConnectedFlag &&
           this.from.isHealthy() &&
           this.to.isHealthy() &&
           this.errorCount < 5; // Max 5 errors before considered unhealthy
  }

  /**
   * Get connection latency
   */
  getLatency(): number {
    return this.latency;
  }

  /**
   * Get connection metrics
   */
  getMetrics(): {
    connectionId: string;
    isConnected: boolean;
    establishedAt: number | undefined;
    latency: number;
    totalRequests: number;
    errorCount: number;
    fromModule: string;
    toModule: string;
  } {
    return {
      connectionId: this.options.connectionId,
      isConnected: this.isConnected(),
      establishedAt: this.establishedAt,
      latency: this.latency,
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      fromModule: this.from.id,
      toModule: this.to.id
    };
  }
}

/**
 * Virtual Module Chain
 *
 * Temporary connection between static instances.
 * Processes requests without maintaining persistent state.
 */
export class VirtualModuleChain {
  private readonly connections: InstanceConnection[] = [];
  private readonly logger: PipelineDebugLogger;
  private readonly metrics: ChainMetrics;

  constructor(
    public readonly id: string,
    public readonly instances: V2ModuleInstance[],
    public readonly routeId: string,
    logger?: PipelineDebugLogger
  ) {
    this.logger = logger || new PipelineDebugLogger();
    this.metrics = {
      id: this.id,
      routeId: this.routeId,
      moduleCount: instances.length,
      connectionCount: 0,
      totalRequests: 0,
      totalErrors: 0,
      averageLatency: 0,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    this.buildConnections();
  }

  /**
   * Process request through the module chain
   */
  async process(request: PipelineRequest): Promise<PipelineResponse> {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    this.metrics.lastActivity = startTime;

    const processingSteps: Array<{
      module: string;
      step: string;
      timestamp: number;
      duration?: number;
      error?: string;
    }> = [];

    let currentData: unknown = request;
    let error: Error | null = null;

    try {
      // Execute each module in sequence
      for (let i = 0; i < this.instances.length; i++) {
        const module = this.instances[i];
        const connection = this.connections[i];

        const stepStart = Date.now();

        try {
          // Process data through module
          currentData = await module.processIncoming(currentData, {
            requestId: request.id,
            routeId: this.routeId,
            chainId: this.id,
            moduleId: module.id,
            position: i,
            totalModules: this.instances.length,
            connectionId: connection?.options.connectionId,
            ephemeral: true
          });

          // Pass data through connection (if exists)
          if (connection) {
            currentData = await connection.transform(currentData);
          }

          // Record successful step
          processingSteps.push({
            module: module.id,
            step: 'processIncoming',
            timestamp: stepStart,
            duration: Date.now() - stepStart
          });

        } catch (moduleError) {
          // Record error step
          processingSteps.push({
            module: module.id,
            step: 'processIncoming',
            timestamp: stepStart,
            duration: Date.now() - stepStart,
            error: moduleError instanceof Error ? moduleError.message : String(moduleError)
          });

          throw moduleError;
        }
      }

    } catch (processingError) {
      error = processingError instanceof Error ? processingError : new Error(String(processingError));
      this.metrics.totalErrors++;
    }

    const duration = Date.now() - startTime;
    this.updateAverageLatency(duration);

    // Create response
    const response: PipelineResponse = {
      id: `response-${request.id}`,
      status: error ? 500 : 200,
      headers: {
        'content-type': 'application/json',
        'x-processing-time': duration.toString(),
        'x-chain-id': this.id,
        'x-route-id': this.routeId
      },
      body: error ? { error: error.message } : (currentData as UnknownObject),
      metadata: {
        timestamp: Date.now(),
        duration,
        traceId: request.metadata?.traceId,
        processingSteps
      }
    };

    // Log processing result
    this.logger.logModule('virtual-chain', 'process-complete', {
      chainId: this.id,
      routeId: this.routeId,
      requestId: request.id,
      duration,
      success: !error,
      error: error instanceof Error ? error.message : String(error),
      steps: processingSteps.length
    });

    if (error) {
      throw error;
    }

    return response;
  }

  /**
   * Get chain status
   */
  getStatus(): ChainStatus {
    const connectionStatuses = this.connections.map(conn => conn.getMetrics());
    const allConnected = this.connections.every(conn => conn.isConnected());

    return {
      id: this.id,
      routeId: this.routeId,
      moduleCount: this.instances.length,
      connectionCount: this.connections.length,
      allConnected,
      moduleTypes: this.instances.map(m => m.type),
      createdAt: this.metrics.createdAt,
      lastActivity: this.metrics.lastActivity,
      connections: connectionStatuses,
      metrics: this.metrics
    };
  }

  /**
   * Cleanup connections (keep instances)
   */
  async cleanupConnections(): Promise<void> {
    this.logger.logModule('virtual-chain', 'cleanup-start', {
      chainId: this.id,
      connectionCount: this.connections.length
    });

    // Disconnect all connections
    for (const connection of this.connections) {
      await connection.onDisconnect();
    }

    // Clear connections array
    this.connections.length = 0;

    this.logger.logModule('virtual-chain', 'cleanup-complete', {
      chainId: this.id
    });
  }

  /**
   * Validate chain health
   */
  validateHealth(): ValidationResult {
    const errors: string[] = [];

    // Check all instances are healthy
    for (const instance of this.instances) {
      if (!instance.isHealthy()) {
        errors.push(`Instance ${instance.id} is not healthy`);
      }
    }

    // Check all connections are healthy
    for (const connection of this.connections) {
      if (!connection.isConnected()) {
        errors.push(`Connection ${connection.options.connectionId} is not healthy`);
      }
    }

    // Check error rate
    const errorRate = this.metrics.totalErrors / this.metrics.totalRequests;
    if (errorRate > 0.1) { // 10% error rate threshold
      errors.push(`High error rate: ${(errorRate * 100).toFixed(2)}%`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: []
    };
  }

  /**
   * Get chain metrics
   */
  getMetrics(): ChainMetrics {
    return { ...this.metrics };
  }

  /**
   * Build connections between instances
   */
  private buildConnections(): void {
    for (let i = 0; i < this.instances.length - 1; i++) {
      const from = this.instances[i];
      const to = this.instances[i + 1];

      const connection = new InstanceConnection(from, to, {
        connectionId: `${this.id}-${i}`,
        temporary: true,
        metadata: {
          chainId: this.id,
          routeId: this.routeId,
          position: i,
          fromModule: from.id,
          toModule: to.id
        }
      });

      this.connections.push(connection);
    }

    this.metrics.connectionCount = this.connections.length;
  }

  /**
   * Update average latency
   */
  private updateAverageLatency(latency: number): void {
    if (this.metrics.totalRequests === 1) {
      this.metrics.averageLatency = latency;
    } else {
      // Exponential moving average
      const alpha = 0.1;
      this.metrics.averageLatency =
        alpha * latency + (1 - alpha) * this.metrics.averageLatency;
    }
  }
}

/**
 * Chain Metrics
 */
export interface ChainMetrics {
  id: string;
  routeId: string;
  moduleCount: number;
  connectionCount: number;
  totalRequests: number;
  totalErrors: number;
  averageLatency: number;
  createdAt: number;
  lastActivity: number;
}

/**
 * Chain Status
 */
export interface ChainStatus {
  id: string;
  routeId: string;
  moduleCount: number;
  connectionCount: number;
  allConnected: boolean;
  moduleTypes: string[];
  createdAt: number;
  lastActivity: number;
  connections: Array<ReturnType<InstanceConnection['getMetrics']>>;
  metrics: ChainMetrics;
}
