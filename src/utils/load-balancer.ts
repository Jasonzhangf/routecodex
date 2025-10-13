/**
 * Load Balancer with Dry-Run Support
 * 负载均衡器 - 支持dry-run模式，提供智能调度决策分析
 */

import type {
  DryRunConfig,
  DryRunResponse,
} from '../modules/dry-run/dry-run-interface.js';

/**
 * 负载均衡目标信息
 */
export interface LoadBalancerTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  weight: number;
  health: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number; // 平均响应时间(毫秒)
  errorRate: number; // 错误率(0-1)
  requestCount: number; // 总请求数
  lastUsed: string; // 最后使用时间
  // Additional fields for testing
  id?: string;
  url?: string;
  connections?: number;
}

/**
 * 负载均衡策略配置
 */
export interface LoadBalancerConfig {
  /** 默认策略 */
  strategy: 'round-robin' | 'weighted' | 'least-connections' | 'fastest-response' | 'random';
  /** 健康检查间隔(毫秒) */
  healthCheckInterval: number;
  /** 失败重试次数 */
  maxRetries: number;
  /** 超时时间(毫秒) */
  timeout: number;
  /** 启用断路器 */
  enableCircuitBreaker: boolean;
  /** 断路器阈值 */
  circuitBreakerThreshold: number;
  /** 断路器恢复时间(毫秒) */
  circuitBreakerRecoveryTime: number;
}

export interface LoadBalancerDecisionDetails {
  selectedTarget: LoadBalancerTarget;
  availableTargets: LoadBalancerTarget[];
  strategy: string;
  reasoning: string;
  confidence: number; // 决策置信度(0-1)
  estimatedResponseTime: number;
  alternatives: LoadBalancerTarget[];
  healthStatus: {
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

export interface LoadBalancerStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  targetDistribution: Record<string, number>;
  strategyUsage: Record<string, number>;
  healthCheckStats: {
    total: number;
    passed: number;
    failed: number;
  };
  circuitBreakerEvents: number;
}

export interface LoadBalancerDryRunResponse extends Omit<DryRunResponse, 'requestSummary'> {
  mode: 'dry-run';
  requestSummary: {
    id: string;
    type: 'load-balancer-analysis';
    timestamp: string;
    strategy: string;
    route?: string; // 可选的route字段以保持兼容性
  };
  loadBalancerDecision: LoadBalancerDecisionDetails;
  performanceAnalysis: {
    currentLoad: number;
    predictedResponseTime: number;
    resourceUtilization: Record<string, number>;
    bottlenecks: string[];
  };
  healthAnalysis: {
    overallHealth: 'excellent' | 'good' | 'fair' | 'poor';
    targetHealthStatus: Array<{
      target: string;
      health: string;
      issues: string[];
    }>;
  };
  recommendations: {
    strategy: string;
    scaling: string;
    health: string;
  };
}

/**
 * Load Balancer Class with Dry-Run Support
 */
export class LoadBalancer {
  private config: LoadBalancerConfig;
  private targets: Map<string, LoadBalancerTarget> = new Map();
  private stats: LoadBalancerStats;
  private dryRunConfig: DryRunConfig;
  private currentIndex: number = 0; // 用于round-robin
  private circuitBreakerState: Map<string, boolean> = new Map();
  private lastHealthCheck: number = 0;

  constructor(config?: Partial<LoadBalancerConfig>) {
    this.config = {
      strategy: 'round-robin',
      healthCheckInterval: 30000, // 30秒
      maxRetries: 3,
      timeout: 5000, // 5秒
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 0.5, // 50%错误率
      circuitBreakerRecoveryTime: 60000, // 1分钟
      ...config,
    };

    this.dryRunConfig = {
      enabled: false,
      verbosity: 'normal',
      includePerformanceEstimate: true,
      includeConfigValidation: true,
    };

    this.stats = this.initializeStats();
  }

  /**
   * 初始化负载均衡器
   */
  async initialize(targets?: LoadBalancerTarget[]): Promise<void> {
    if (targets) {
      this.updateTargets(targets);
    }
    console.log('⚖️ Load Balancer initialized with strategy:', this.config.strategy);
  }

  /**
   * 更新目标列表
   */
  updateTargets(targets: LoadBalancerTarget[]): void {
    this.targets.clear();
    targets.forEach(target => {
      this.targets.set(this.getTargetKey(target), target);
    });
    console.log('📋 Load Balancer targets updated:', targets.length);
  }

  /**
   * 选择目标（正常模式）
   */
  async selectTarget(targets: LoadBalancerTarget[], _context?: Record<string, unknown>): Promise<LoadBalancerTarget> {
    if (this.dryRunConfig.enabled) {
      // 在dry-run模式下，返回第一个可用的目标
      return this.selectTargetForDryRun(targets);
    }

    // 正常的负载均衡逻辑
    const availableTargets = targets.filter(t => this.isTargetAvailable(t));

    if (availableTargets.length === 0) {
      throw new Error('No available targets for load balancing');
    }

    let selectedTarget: LoadBalancerTarget;

    switch (this.config.strategy) {
      case 'weighted':
        selectedTarget = this.weightedSelection(availableTargets);
        break;
      case 'least-connections':
        selectedTarget = this.leastConnectionsSelection(availableTargets);
        break;
      case 'fastest-response':
        selectedTarget = this.fastestResponseSelection(availableTargets);
        break;
      case 'random':
        selectedTarget = this.randomSelection(availableTargets);
        break;
      case 'round-robin':
      default:
        selectedTarget = this.roundRobinSelection(availableTargets);
        break;
    }

    // 更新统计信息
    this.updateStats(selectedTarget, true);

    return selectedTarget;
  }

  /**
   * 执行dry-run分析
   */
  async executeDryRun(
    targets: LoadBalancerTarget[],
    _context?: Record<string, unknown>
  ): Promise<LoadBalancerDryRunResponse> {
    const startTime = Date.now();
    const analysisId = `dryrun_lb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log('🔍 Starting Load Balancer dry-run analysis...');

    try {
      // 检查目标健康状态
      const healthStatus = this.analyzeTargetHealth(targets);

      // 分析各种策略的结果
      const strategyAnalysis = await this.analyzeAllStrategies(targets);

      // 性能分析
      const performanceAnalysis = this.analyzePerformance(targets);

      // 生成建议
      const recommendations = this.generateRecommendations(targets, strategyAnalysis);

      const response: LoadBalancerDryRunResponse = {
        mode: 'dry-run',
        requestSummary: {
          id: analysisId,
          type: 'load-balancer-analysis',
          timestamp: new Date().toISOString(),
          strategy: this.config.strategy,
        },
        routingDecision: await this.simulateRoutingDecision(targets, analysisId),
        fieldConversion: this.simulateFieldConversion(),
        protocolProcessing: this.simulateProtocolProcessing(),
        loadBalancerDecision: strategyAnalysis[this.config.strategy],
        performanceAnalysis,
        healthAnalysis: healthStatus,
        executionPlan: this.generateLoadBalancerExecutionPlan(targets),
        recommendations,
        totalDryRunTimeMs: 0,
      };

      // 添加性能估算
      if (this.dryRunConfig.includePerformanceEstimate) {
        response.performanceEstimate = this.estimateLoadBalancerPerformance(targets);
      }

      // 添加配置验证
      if (this.dryRunConfig.includeConfigValidation) {
        response.configValidation = this.validateLoadBalancerConfig(targets);
      }

      response.totalDryRunTimeMs = Date.now() - startTime;

      console.log(`✅ Load Balancer dry-run analysis completed in ${response.totalDryRunTimeMs}ms`);
      return response;
    } catch (error) {
      console.error('❌ Load Balancer dry-run analysis failed:', error);
      throw error;
    }
  }

  /**
   * 设置dry-run模式
   */
  setDryRunMode(enabled: boolean, config?: Partial<DryRunConfig>): void {
    this.dryRunConfig.enabled = enabled;
    if (config) {
      this.dryRunConfig = { ...this.dryRunConfig, ...config };
    }
    console.log(`🔍 Load Balancer dry-run mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 获取统计信息
   */
  getStats(): LoadBalancerStats {
    return { ...this.stats };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = this.initializeStats();
    console.log('📊 Load Balancer statistics reset');
  }

  /**
   * 获取当前策略
   */
  getStrategy(): string {
    return this.config.strategy;
  }

  /**
   * 获取配置
   */
  getConfig(): LoadBalancerConfig {
    return { ...this.config };
  }

  /**
   * 设置策略
   */
  setStrategy(
    strategy: 'round-robin' | 'weighted' | 'least-connections' | 'fastest-response' | 'random'
  ): void {
    this.config.strategy = strategy;
    console.log('🔄 Load Balancer strategy changed to:', strategy);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<LoadBalancerConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('⚙️ Load Balancer configuration updated');
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.config.healthCheckInterval) {
      return;
    }

    this.lastHealthCheck = now;
    let healthyCount = 0;

    for (const [key, target] of this.targets) {
      const isHealthy = await this.checkTargetHealth(target);
      if (!isHealthy && this.config.enableCircuitBreaker) {
        this.circuitBreakerState.set(key, true);
        console.log(`⚠️ Target ${key} marked as unhealthy, circuit breaker activated`);
      } else if (isHealthy) {
        this.circuitBreakerState.delete(key);
        healthyCount++;
      }
    }

    this.stats.healthCheckStats.total++;
    this.stats.healthCheckStats.passed = healthyCount;
    this.stats.healthCheckStats.failed = this.targets.size - healthyCount;

    console.log(`🏥 Health check completed: ${healthyCount}/${this.targets.size} targets healthy`);
  }

  // ========== 私有方法 ==========

  private initializeStats(): LoadBalancerStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      targetDistribution: {},
      strategyUsage: {},
      healthCheckStats: {
        total: 0,
        passed: 0,
        failed: 0,
      },
      circuitBreakerEvents: 0,
    };
  }

  private getTargetKey(target: LoadBalancerTarget): string {
    return `${target.providerId}.${target.modelId}.${target.keyId}`;
  }

  private isTargetAvailable(target: LoadBalancerTarget): boolean {
    const key = this.getTargetKey(target);
    return target.health === 'healthy' && !this.circuitBreakerState.has(key);
  }

  private roundRobinSelection(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    const selected = targets[this.currentIndex % targets.length];
    this.currentIndex++;
    return selected;
  }

  private weightedSelection(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
    let random = Math.random() * totalWeight;

    for (const target of targets) {
      random -= target.weight;
      if (random <= 0) {
        return target;
      }
    }

    return targets[0];
  }

  private leastConnectionsSelection(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    return targets.reduce((min, target) => (target.requestCount < min.requestCount ? target : min));
  }

  private fastestResponseSelection(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    return targets.reduce((fastest, target) =>
      target.responseTime < fastest.responseTime ? target : fastest
    );
  }

  private randomSelection(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    return targets[Math.floor(Math.random() * targets.length)];
  }

  private updateStats(target: LoadBalancerTarget, success: boolean): void {
    this.stats.totalRequests++;

    if (success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }

    const key = this.getTargetKey(target);
    this.stats.targetDistribution[key] = (this.stats.targetDistribution[key] || 0) + 1;
    this.stats.strategyUsage[this.config.strategy] =
      (this.stats.strategyUsage[this.config.strategy] || 0) + 1;
  }

  private async checkTargetHealth(target: LoadBalancerTarget): Promise<boolean> {
    // 简化的健康检查逻辑
    // 实际实现中，这里可能会发送测试请求或检查指标
    return target.health === 'healthy' && target.errorRate < 0.5;
  }

  private async analyzeAllStrategies(
    targets: LoadBalancerTarget[]
  ): Promise<Record<string, LoadBalancerDecisionDetails>> {
    const strategies = [
      'round-robin',
      'weighted',
      'least-connections',
      'fastest-response',
      'random',
    ];
    const analysis: Record<string, LoadBalancerDecisionDetails> = {};

    for (const strategy of strategies) {
      analysis[strategy] = await this.analyzeStrategy(targets, strategy);
    }

    return analysis;
  }

  private async analyzeStrategy(
    targets: LoadBalancerTarget[],
    strategy: string
  ): Promise<LoadBalancerDecisionDetails> {
    let selectedTarget: LoadBalancerTarget;

    switch (strategy) {
      case 'weighted':
        selectedTarget = this.weightedSelection(targets);
        break;
      case 'least-connections':
        selectedTarget = this.leastConnectionsSelection(targets);
        break;
      case 'fastest-response':
        selectedTarget = this.fastestResponseSelection(targets);
        break;
      case 'random':
        selectedTarget = this.randomSelection(targets);
        break;
      case 'round-robin':
      default:
        selectedTarget = this.roundRobinSelection(targets);
        break;
    }

    return {
      selectedTarget,
      availableTargets: targets,
      strategy,
      reasoning: this.generateStrategyReasoning(strategy, selectedTarget, targets),
      confidence: this.calculateStrategyConfidence(strategy, targets),
      estimatedResponseTime: selectedTarget.responseTime,
      alternatives: targets.filter(t => t !== selectedTarget),
      healthStatus: this.calculateHealthStatus(targets),
    };
  }

  private generateStrategyReasoning(
    strategy: string,
    selected: LoadBalancerTarget,
    _targets: LoadBalancerTarget[]
  ): string {
    switch (strategy) {
      case 'weighted':
        return `Selected based on weight (${selected.weight}) and distribution`;
      case 'least-connections':
        return `Selected based on lowest connection count (${selected.requestCount})`;
      case 'fastest-response':
        return `Selected based on fastest response time (${selected.responseTime}ms)`;
      case 'random':
        return 'Selected randomly for distribution';
      case 'round-robin':
      default:
        return 'Selected using round-robin algorithm';
    }
  }

  private calculateStrategyConfidence(strategy: string, targets: LoadBalancerTarget[]): number {
    const healthyCount = targets.filter(t => t.health === 'healthy').length;
    const baseConfidence = healthyCount / targets.length;

    // 根据策略调整置信度
    switch (strategy) {
      case 'fastest-response':
        return baseConfidence * 0.9; // 响应时间可能波动
      case 'random':
        return baseConfidence * 0.7; // 随机性较高
      default:
        return baseConfidence * 0.85;
    }
  }

  private calculateHealthStatus(targets: LoadBalancerTarget[]) {
    const status = { healthy: 0, degraded: 0, unhealthy: 0 };
    targets.forEach(target => {
      status[target.health]++;
    });
    return status;
  }

  private analyzeTargetHealth(targets: LoadBalancerTarget[]) {
    const overallHealth = this.calculateOverallHealth(targets);
    const targetHealthStatus = targets.map(target => ({
      target: this.getTargetKey(target),
      health: target.health,
      issues: this.getTargetHealthIssues(target),
    }));

    return {
      overallHealth,
      targetHealthStatus,
    };
  }

  private calculateOverallHealth(
    targets: LoadBalancerTarget[]
  ): 'excellent' | 'good' | 'fair' | 'poor' {
    const healthyCount = targets.filter(t => t.health === 'healthy').length;
    const healthRatio = healthyCount / targets.length;

    if (healthRatio >= 0.9) {
      return 'excellent';
    }
    if (healthRatio >= 0.7) {
      return 'good';
    }
    if (healthRatio >= 0.5) {
      return 'fair';
    }
    return 'poor';
  }

  private getTargetHealthIssues(target: LoadBalancerTarget): string[] {
    const issues: string[] = [];

    if (target.health !== 'healthy') {
      issues.push(`Target health is ${target.health}`);
    }

    if (target.errorRate > 0.1) {
      issues.push(`High error rate: ${(target.errorRate * 100).toFixed(1)}%`);
    }

    if (target.responseTime > 5000) {
      issues.push(`High response time: ${target.responseTime}ms`);
    }

    return issues;
  }

  private analyzePerformance(targets: LoadBalancerTarget[]) {
    const totalRequests = targets.reduce((sum, t) => sum + t.requestCount, 0);
    const avgResponseTime = targets.reduce((sum, t) => sum + t.responseTime, 0) / targets.length;

    return {
      currentLoad: totalRequests > 0 ? Math.min(totalRequests / 1000, 1) : 0, // 归一化负载
      predictedResponseTime: avgResponseTime,
      resourceUtilization: targets.reduce(
        (util, target) => {
          const key = this.getTargetKey(target);
          util[key] = target.requestCount / Math.max(target.requestCount + 100, 1); // 简化的利用率计算
          return util;
        },
        {} as Record<string, number>
      ),
      bottlenecks: targets
        .filter(t => t.responseTime > 3000 || t.errorRate > 0.2)
        .map(t => this.getTargetKey(t)),
    };
  }

  private generateRecommendations(
    targets: LoadBalancerTarget[],
    strategyAnalysis: Record<string, LoadBalancerDecisionDetails>
  ) {
    const bestStrategy = Object.entries(strategyAnalysis).sort(
      ([, a], [, b]) => b.confidence - a.confidence
    )[0];

    return {
      strategy: `Recommended strategy: ${bestStrategy[0]} (confidence: ${bestStrategy[1].confidence.toFixed(2)})`,
      scaling:
        targets.length < 3
          ? 'Consider adding more targets for better load distribution'
          : 'Current target count is adequate',
      health: 'Enable health checks and circuit breakers for better reliability',
    };
  }

  private async simulateRoutingDecision(targets: LoadBalancerTarget[], analysisId: string) {
    const selectedTarget = this.selectTargetForDryRun(targets);

    return {
      requestId: analysisId,
      routeName: 'default',
      selectedTarget: {
        providerId: selectedTarget.providerId,
        modelId: selectedTarget.modelId,
        keyId: selectedTarget.keyId,
        actualKey: 'hidden-for-security',
      },
      availableTargets: targets.map(t => ({
        providerId: t.providerId,
        modelId: t.modelId,
        keyId: t.keyId,
        health: t.health,
      })),
      loadBalancerDecision: {
        algorithm: this.config.strategy,
        weights: targets.reduce(
          (acc, t) => {
            acc[this.getTargetKey(t)] = t.weight;
            return acc;
          },
          {} as Record<string, number>
        ),
        selectedWeight: selectedTarget.weight,
        reasoning: this.generateStrategyReasoning(this.config.strategy, selectedTarget, targets),
      },
      timestamp: new Date().toISOString(),
      decisionTimeMs: 2,
    };
  }

  private simulateFieldConversion() {
    return {
      originalFields: ['model', 'messages', 'temperature'],
      convertedFields: ['model', 'messages', 'temperature'],
      fieldMappings: [
        { from: 'model', to: 'model', transformation: 'passthrough' },
        { from: 'messages', to: 'messages', transformation: 'passthrough' },
        { from: 'temperature', to: 'temperature', transformation: 'passthrough' },
      ],
      conversionTimeMs: 1,
      success: true,
    };
  }

  private simulateProtocolProcessing() {
    return {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      conversionSteps: [],
      processingTimeMs: 1,
      requiresConversion: false,
    };
  }

  private generateLoadBalancerExecutionPlan(_targets: LoadBalancerTarget[]) {
    return [
      {
        step: 'target_health_check',
        module: 'load-balancer',
        description: 'Check health status of all available targets',
        estimatedTimeMs: 5,
      },
      {
        step: 'strategy_execution',
        module: 'load-balancer',
        description: `Execute ${this.config.strategy} load balancing strategy`,
        estimatedTimeMs: 2,
      },
      {
        step: 'target_selection',
        module: 'load-balancer',
        description: 'Select optimal target based on strategy and health',
        estimatedTimeMs: 1,
      },
      {
        step: 'circuit_breaker_check',
        module: 'load-balancer',
        description: 'Verify target is not in circuit breaker state',
        estimatedTimeMs: 1,
      },
    ];
  }

  private estimateLoadBalancerPerformance(targets: LoadBalancerTarget[]) {
    const avgResponseTime = targets.reduce((sum, t) => sum + t.responseTime, 0) / targets.length;

    return {
      estimatedTotalTimeMs: avgResponseTime + 10, // 加上负载均衡开销
      breakdown: {
        routing: 2,
        conversion: 1,
        protocol: 1,
        execution: avgResponseTime,
        response: 5,
      },
      confidence: 0.8,
      baselineSource: 'historical' as const,
    };
  }

  private validateLoadBalancerConfig(targets: LoadBalancerTarget[]) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (targets.length === 0) {
      errors.push('No targets configured for load balancing');
    }

    if (targets.length === 1) {
      warnings.push('Only one target configured, load balancing will have limited effect');
    }

    const unhealthyTargets = targets.filter(t => t.health !== 'healthy');
    if (unhealthyTargets.length > 0) {
      warnings.push(`${unhealthyTargets.length} targets are in unhealthy state`);
    }

    return {
      routingConfig: { valid: errors.length === 0, errors: [], warnings: [] },
      pipelineConfig: { valid: true, errors: [], warnings: [] },
      targetConfig: { valid: errors.length === 0, errors, warnings },
    };
  }

  private selectTargetForDryRun(targets: LoadBalancerTarget[]): LoadBalancerTarget {
    // 在dry-run模式下，选择第一个健康的目标
    const healthyTargets = targets.filter(t => t.health === 'healthy');
    if (healthyTargets.length === 0) {
      return targets[0]; // 如果没有健康的目标，返回第一个
    }
    return healthyTargets[0];
  }
}
