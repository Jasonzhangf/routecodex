/**
 * Hybrid Pipeline Manager Types
 * 
 * Types for V1/V2 hybrid pipeline manager that supports seamless migration.
 */

import type { PipelineRequest, PipelineResponse } from '../../../interfaces/pipeline-interfaces.js';
import type { V2SystemConfig } from '../../types/v2-types.js';
import type { PipelineManager } from '../../core/pipeline-manager.js';
import type { V2PipelineManager } from '../v2-pipeline-manager.js';

/**
 * Pipeline mode configuration
 */
export type PipelineMode = 'v1' | 'v2' | 'hybrid';

/**
 * Traffic splitting strategy
 */
export interface TrafficSplitStrategy {
  /** Percentage of traffic to route to V2 (0-100) */
  v2Percentage: number;
  /** Criteria for routing decisions */
  criteria: {
    /** Route based on request hash */
    byHash: boolean;
    /** Route based on user ID (if available) */
    byUser: boolean;
    /** Route based on endpoint */
    byEndpoint: boolean;
    /** Route based on provider/model */
    byProvider: boolean;
  };
  /** Endpoint-specific overrides */
  endpointOverrides: Record<string, number>;
  /** Provider-specific overrides */
  providerOverrides: Record<string, number>;
}

/**
 * Hybrid pipeline configuration
 */
export interface HybridPipelineConfig {
  /** Current pipeline mode */
  mode: PipelineMode;
  /** V2 system configuration (required when mode !== 'v1') */
  v2Config?: V2SystemConfig;
  /** Traffic splitting strategy (for hybrid mode) */
  trafficSplit?: TrafficSplitStrategy;
  /** Migration settings */
  migration: {
    /** Enable automatic progressive migration */
    enableProgressive: boolean;
    /** Migration schedule */
    schedule: {
      /** Start with this V2 percentage */
      startPercentage: number;
      /** Target percentage */
      targetPercentage: number;
      /** Migration duration in hours */
      durationHours: number;
      /** Update interval in minutes */
      updateIntervalMinutes: number;
    };
  };
  /** Health check settings */
  healthCheck: {
    /** Enable health-based routing */
    enabled: boolean;
    /** Error rate threshold for switching back */
    errorRateThreshold: number;
    /** Latency threshold for switching back */
    latencyThresholdMs: number;
    /** Minimum samples before making decisions */
    minSamples: number;
  };
  /** Fallback settings */
  fallback: {
    /** Enable automatic fallback to V1 on errors */
    enabled: boolean;
    /** Errors that trigger fallback */
    errorTypes: string[];
    /** Cooldown period in milliseconds */
    cooldownMs: number;
  };
}

/**
 * Pipeline selection result
 */
export interface PipelineSelection {
  /** Selected pipeline mode */
  mode: PipelineMode;
  /** Selection reason */
  reason: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Metadata about the selection */
  metadata: Record<string, unknown>;
}

/**
 * Hybrid pipeline metrics
 */
export interface HybridPipelineMetrics {
  /** Total requests processed */
  totalRequests: number;
  /** Requests by mode */
  requestsByMode: Record<PipelineMode, number>;
  /** Success rates by mode */
  successRates: Record<PipelineMode, number>;
  /** Average latency by mode */
  averageLatency: Record<PipelineMode, number>;
  /** Error rates by mode */
  errorRates: Record<PipelineMode, number>;
  /** Current traffic split */
  currentSplit: {
    v1Percentage: number;
    v2Percentage: number;
  };
  /** Health status by mode */
  healthStatus: Record<PipelineMode, 'healthy' | 'degraded' | 'unhealthy'>;
  /** Migration progress (0-1) */
  migrationProgress: number;
}

/**
 * Request routing decision
 */
export interface RoutingDecision {
  /** Target pipeline */
  target: PipelineMode;
  /** Routing reason */
  reason: string;
  /** Request metadata */
  requestMetadata: {
    requestId: string;
    endpoint: string;
    provider?: string;
    model?: string;
    timestamp: number;
  };
  /** Decision confidence */
  confidence: number;
}
