/**
 * Virtual Router Dry-Run Framework
 * 
 * 在虚拟路由器阶段提供dry-run功能，让负载均衡决策可以被验证和测试
 * 而不需要实际执行后续的流水线
 */

import { ConfigRequestClassifier } from './classifiers/config-request-classifier.js';
import { ConfigRoutingDecision } from './classifiers/config-routing-decision.js';
import type { 
  ConfigClassificationInput, 
  ConfigClassificationResult 
} from './classifiers/config-request-classifier.js';
import type { RoutingDecisionInput, RoutingDecisionResult } from './classifiers/config-routing-decision.js';

export interface VirtualRouterDryRunConfig {
  enabled: boolean;
  includeLoadBalancerDetails?: boolean;
  includeHealthStatus?: boolean;
  includeWeightCalculation?: boolean;
  simulateProviderHealth?: boolean;
  forcedProviderId?: string; // 用于测试特定提供商选择
}

export interface VirtualRouterDryRunResult {
  stage: 'virtual-router';
  timestamp: string;
  executionTimeMs: number;
  routingDecision: RoutingDecisionResult;
  loadBalancerAnalysis?: {
    algorithm: string;
    providerWeights: Record<string, number>;
    healthStatuses: Record<string, 'healthy' | 'degraded' | 'unhealthy'>;
    selectedProvider: string;
    selectionReason: string;
    availableProviders: string[];
    filteredProviders?: string[]; // 被健康检查过滤掉的提供商
  };
  classificationDetails?: {
    protocol: string;
    model: string;
    tokenCount: number;
    complexity: number;
    confidence: number;
  };
  configValidation?: {
    routingConfigValid: boolean;
    loadBalancerConfigValid: boolean;
    errors: string[];
    warnings: string[];
  };
  simulated?: boolean;
}

export class VirtualRouterDryRunExecutor {
  private classifier: ConfigRequestClassifier | null = null;
  private routingDecision: ConfigRoutingDecision | null = null;
  private config: VirtualRouterDryRunConfig;

  constructor(config: VirtualRouterDryRunConfig) {
    this.config = config;
  }

  /**
   * 初始化分类器和路由决策器
   */
  async initialize(moduleConfig: any): Promise<void> {
    if (!this.config.enabled) {return;}

    try {
      // 创建分类器（需要 classificationConfig 节点）
      const classificationConfig = moduleConfig?.classificationConfig;
      if (!classificationConfig) {
        throw new Error('classificationConfig is missing in moduleConfig');
      }
      this.classifier = ConfigRequestClassifier.fromModuleConfig(classificationConfig);
      
      // 创建路由决策器
      if (moduleConfig.classificationConfig?.routingDecisions) {
        this.routingDecision = ConfigRoutingDecision.fromModuleConfig(moduleConfig.classificationConfig);
      }
    } catch (error) {
      throw new Error(`Failed to initialize virtual router dry-run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 执行虚拟路由器dry-run，包含真实的负载均衡决策
   */
  async executeDryRun(input: ConfigClassificationInput): Promise<VirtualRouterDryRunResult> {
    if (!this.config.enabled) {
      throw new Error('Virtual router dry-run is not enabled');
    }

    const startTime = Date.now();
    
    try {
      // 执行真实的分类逻辑
      let classificationResult: ConfigClassificationResult;
      
      if (this.classifier) {
        classificationResult = await this.classifier.classify(input);
      } else {
        throw new Error('Classifier not initialized');
      }

      // 提取路由决策结果
      const routingDecision = classificationResult.analysis?.routingDecision;
      
      // 构建详细的负载均衡分析
      const loadBalancerAnalysis = this.analyzeLoadBalancerDecision(
        routingDecision,
        classificationResult
      );

      // 配置验证
      const configValidation = this.validateConfig();

      return {
        stage: 'virtual-router',
        timestamp: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime,
        routingDecision: routingDecision,
        loadBalancerAnalysis,
        classificationDetails: {
          protocol: classificationResult.analysis?.protocol || 'unknown',
          model: classificationResult.modelTier,
          tokenCount: classificationResult.analysis?.tokenAnalysis?.totalTokens || 0,
          complexity: classificationResult.analysis?.toolAnalysis?.complexity?.medium || 0,
          confidence: classificationResult.confidence
        },
        configValidation,
        simulated: false // 这是真实执行，不是模拟
      };

    } catch (error) {
      throw new Error(`Virtual router dry-run execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 分析负载均衡决策的详细信息
   */
  private analyzeLoadBalancerDecision(
    routingDecision: any,
    classificationResult: ConfigClassificationResult
  ) {
    if (!this.config.includeLoadBalancerDetails) {
      return undefined;
    }

    const selectedTarget = routingDecision?.selectedTarget;
    const availableTargets = routingDecision?.availableTargets || [];
    
    // 获取提供商权重（如果配置了的话）
    const providerWeights: Record<string, number> = {};
    const healthStatuses: Record<string, 'healthy' | 'degraded' | 'unhealthy'> = {};
    
    if (this.routingDecision && this.config.includeWeightCalculation) {
      // 从路由决策器获取权重信息
      const routingConfig = (this.routingDecision as any).routingDecisions;
      if (routingConfig) {
        Object.entries(routingConfig).forEach(([provider, config]: [string, any]) => {
          if (config.weight !== undefined) {
            providerWeights[provider] = config.weight;
          }
          if (this.config.includeHealthStatus) {
            healthStatuses[provider] = this.config.simulateProviderHealth ? 
              this.simulateHealthStatus(provider) : 'healthy';
          }
        });
      }
    }

    // 构建选择原因
    let selectionReason = routingDecision?.reasoning || 'Based on routing configuration';
    if (this.config.forcedProviderId) {
      selectionReason = `Forced provider selection for testing: ${this.config.forcedProviderId}`;
    }

    return {
      algorithm: routingDecision?.algorithm || 'weighted-round-robin',
      providerWeights,
      healthStatuses,
      selectedProvider: selectedTarget?.providerId || 'unknown',
      selectionReason,
      availableProviders: availableTargets.map((t: any) => t.providerId),
      filteredProviders: [] // 可以扩展添加被健康检查过滤的提供商
    };
  }

  /**
   * 模拟提供商健康状态（用于测试）
   */
  private simulateHealthStatus(providerId: string): 'healthy' | 'degraded' | 'unhealthy' {
    // 基于提供商ID的哈希值模拟不同的健康状态
    const hash = providerId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    
    const healthValue = Math.abs(hash) % 100;
    if (healthValue < 70) {return 'healthy';}
    if (healthValue < 90) {return 'degraded';}
    return 'unhealthy';
  }

  /**
   * 验证配置
   */
  private validateConfig() {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (!this.routingDecision) {
      errors.push('Routing decision module not initialized');
    }
    
    if (!this.classifier) {
      errors.push('Classifier module not initialized');
    }

    // 可以添加更多的配置验证逻辑
    if (this.config.includeWeightCalculation && !this.config.includeLoadBalancerDetails) {
      warnings.push('Weight calculation requested but load balancer details disabled');
    }

    return {
      routingConfigValid: this.routingDecision !== null,
      loadBalancerConfigValid: this.config.includeLoadBalancerDetails || true,
      errors,
      warnings
    };
  }

  /**
   * 获取dry-run配置
   */
  getConfig(): VirtualRouterDryRunConfig {
    return { ...this.config };
  }

  /**
   * 更新dry-run配置
   */
  updateConfig(newConfig: Partial<VirtualRouterDryRunConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}

export const virtualRouterDryRunExecutor = new VirtualRouterDryRunExecutor({
  enabled: false // 默认禁用，需要显式启用
});
