/**
 * Traffic Splitter
 * 
 * Handles intelligent traffic splitting between V1 and V2 pipelines
 * based on configured strategies and real-time metrics.
 */

import type { PipelineRequest } from '../../../interfaces/pipeline-interfaces.js';
import type { TrafficSplitStrategy, RoutingDecision } from './hybrid-config-types.js';
import { PipelineDebugLogger } from '../../../utils/debug-logger.js';
import crypto from 'crypto';

/**
 * Traffic Splitter
 * 
 * Implements various strategies for splitting traffic between V1 and V2.
 */
export class TrafficSplitter {
  private readonly logger: PipelineDebugLogger;
  private readonly strategy: TrafficSplitStrategy;
  private readonly requestHistory = new Map<string, { mode: string; timestamp: number }>();

  constructor(
    strategy: TrafficSplitStrategy,
    logger?: PipelineDebugLogger
  ) {
    this.strategy = strategy;
    this.logger = logger || new PipelineDebugLogger();
  }

  /**
   * Make routing decision for a request
   */
  makeDecision(request: PipelineRequest): RoutingDecision {
    const requestMetadata = this.extractRequestMetadata(request);
    const basePercentage = this.strategy.v2Percentage;
    
    let targetPercentage = basePercentage;
    let reason = `base-split-${basePercentage}%`;
    
    // Apply endpoint-specific overrides
    if (this.strategy.criteria.byEndpoint && requestMetadata.endpoint) {
      const endpointOverride = this.strategy.endpointOverrides[requestMetadata.endpoint];
      if (typeof endpointOverride === 'number') {
        targetPercentage = endpointOverride;
        reason = `endpoint-${requestMetadata.endpoint}-${endpointPercentage}%`;
      }
    }
    
    // Apply provider-specific overrides
    if (this.strategy.criteria.byProvider && requestMetadata.provider) {
      const providerOverride = this.strategy.providerOverrides[requestMetadata.provider];
      if (typeof providerOverride === 'number') {
        targetPercentage = providerOverride;
        reason = `provider-${requestMetadata.provider}-${providerPercentage}%`;
      }
    }
    
    // Make final decision
    const target = this.selectTarget(targetPercentage, requestMetadata);
    const confidence = this.calculateConfidence(targetPercentage, reason);
    
    const decision: RoutingDecision = {
      target,
      reason,
      requestMetadata,
      confidence
    };
    
    this.logger.logModule('traffic-splitter', 'decision-made', {
      requestId: requestMetadata.requestId,
      target,
      reason,
      confidence,
      v2Percentage: targetPercentage
    });
    
    return decision;
  }

  /**
   * Extract metadata from request
   */
  private extractRequestMetadata(request: PipelineRequest) {
    const endpoint = (request.metadata?.entryEndpoint as string) || 'unknown';
    const provider = request.route?.providerId;
    const model = request.route?.modelId;
    const requestId = request.route?.requestId || 'unknown';
    const timestamp = request.route?.timestamp || Date.now();
    
    return {
      requestId,
      endpoint,
      provider,
      model,
      timestamp
    };
  }

  /**
   * Select target based on percentage
   */
  private selectTarget(v2Percentage: number, metadata: any): 'v1' | 'v2' {
    // Hash-based selection for consistency
    if (this.strategy.criteria.byHash) {
      const hash = crypto.createHash('md5')
        .update(metadata.requestId)
        .digest('hex');
      const hashValue = parseInt(hash.substring(0, 8), 16) / 0xffffffff;
      return hashValue < (v2Percentage / 100) ? 'v2' : 'v1';
    }
    
    // User-based selection (if user ID available)
    if (this.strategy.criteria.byUser && metadata.userId) {
      const userHash = crypto.createHash('md5')
        .update(metadata.userId)
        .digest('hex');
      const userHashValue = parseInt(userHash.substring(0, 8), 16) / 0xffffffff;
      return userHashValue < (v2Percentage / 100) ? 'v2' : 'v1';
    }
    
    // Random selection
    return Math.random() < (v2Percentage / 100) ? 'v2' : 'v1';
  }

  /**
   * Calculate confidence in the decision
   */
  private calculateConfidence(v2Percentage: number, reason: string): number {
    // High confidence for extreme percentages
    if (v2Percentage <= 5 || v2Percentage >= 95) {
      return 0.95;
    }
    
    // Medium confidence for endpoint/provider overrides
    if (reason.includes('endpoint-') || reason.includes('provider-')) {
      return 0.85;
    }
    
    // Lower confidence for random splitting
    return 0.7;
  }

  /**
   * Update traffic split strategy
   */
  updateStrategy(newStrategy: Partial<TrafficSplitStrategy>): void {
    Object.assign(this.strategy, newStrategy);
    this.logger.logModule('traffic-splitter', 'strategy-updated', {
      newStrategy
    });
  }

  /**
   * Get current strategy
   */
  getStrategy(): TrafficSplitStrategy {
    return { ...this.strategy };
  }

  /**
   * Clean up old request history
   */
  cleanup(): void {
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    for (const [key, value] of this.requestHistory) {
      if (value.timestamp < cutoffTime) {
        this.requestHistory.delete(key);
      }
    }
  }
}
