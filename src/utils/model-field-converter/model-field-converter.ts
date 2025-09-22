/**
 * Model Field Converter
 * 模型字段转换器 - 主转换器实现
 */

import type {
  ModelFieldConverterConfig,
  ConversionContext,
  ConversionResult,
  BatchConversionResult,
  ConverterStatus,
  ConverterMetrics,
  HealthStatus,
  OpenAIRequest,
  ExtendedRoutingInfo
} from './types.js';
import { RequestTransformer } from './request-transformer.js';
import { FieldMappingRules } from './field-mapping-rules.js';

/**
 * 模型字段转换器主类
 */
export class ModelFieldConverter {
  private config: ModelFieldConverterConfig;
  private requestTransformer: RequestTransformer;
  private fieldMappingRules: FieldMappingRules;
  private isInitialized: boolean = false;
  private metrics: ConverterMetrics;
  private startTime: number;

  constructor(config: ModelFieldConverterConfig = {}) {
    // Extract defaults from pipeline configs if available
    let defaultMaxTokens = 32000;
    let defaultModel = 'qwen3-coder-plus';

    if (config.pipelineConfigs && Object.keys(config.pipelineConfigs).length > 0) {
      const firstConfigKey = Object.keys(config.pipelineConfigs)[0];
      const firstConfig = config.pipelineConfigs[firstConfigKey];
      defaultMaxTokens = firstConfig.model?.maxTokens || 32000;

      // Extract model ID from the pipeline config key (format: provider.model.keyId)
      const keyParts = firstConfigKey.split('.');
      if (keyParts.length >= 2) {
        defaultModel = keyParts[1]; // Use the modelId from the config key
      }
    }

    this.config = {
      debugMode: false,
      enableTracing: true,
      strictValidation: true,
      maxConversionDepth: 10,
      enableMetrics: true,
      traceSampling: 1.0,
      defaultMaxTokens,
      defaultModel,
      ...config
    };

    this.requestTransformer = new RequestTransformer();
    this.fieldMappingRules = new FieldMappingRules({
      defaultMaxTokens: this.config.defaultMaxTokens,
      defaultModel: this.config.defaultModel,
      pipelineConfigs: config.pipelineConfigs
    });
    this.metrics = this.initializeMetrics();
    this.startTime = Date.now();
  }

  /**
   * 初始化转换器
   */
  async initialize(config?: Partial<ModelFieldConverterConfig>): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    try {
      // 验证配置
      this.validateConfig();

      // 初始化映射规则
      this.initializeMappingRules();

      this.isInitialized = true;

      if (this.config.debugMode) {
        console.log('🔄 Model Field Converter initialized successfully');
        console.log('📊 Configuration:', this.config);
        console.log('📋 Rules Statistics:', this.fieldMappingRules.getRuleStatistics());
      }

    } catch (error) {
      console.error('❌ Failed to initialize Model Field Converter:', error);
      throw error;
    }
  }

  /**
   * 转换单个请求
   */
  async convertRequest(
    request: OpenAIRequest,
    pipelineConfig: any,
    routingInfo: any
  ): Promise<ConversionResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const conversionContext: ConversionContext = {
      pipelineConfig,
      routingInfo,
      originalRequest: request,
      metadata: {
        conversionId: this.generateConversionId(),
        timestamp: new Date().toISOString()
      }
    };

    try {
      const result = await this.requestTransformer.transformOpenAIRequest(
        request,
        conversionContext
      );

      // 更新指标
      if (this.config.enableMetrics) {
        this.updateMetrics(result, Date.now() - startTime);
      }

      // 调试日志
      if (this.config.debugMode) {
        this.logConversionResult(result);
      }

      return result;

    } catch (error) {
      const errorResult: ConversionResult = {
        convertedRequest: request,
        debugInfo: {
          conversionId: conversionContext.metadata!.conversionId,
          originalRequest: request,
          routingInfo,
          pipelineConfig,
          conversionTrace: [],
          appliedRules: [],
          metrics: {
            totalSteps: 0,
            totalDuration: 0,
            averageStepTime: 0,
            memoryUsage: 0,
            ruleUsage: {}
          },
          meta: {
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
          }
        },
        success: false,
        errors: [error instanceof Error ? error.message : String(error)]
      };

      // 更新错误指标
      if (this.config.enableMetrics) {
        this.metrics.failedConversions++;
      }

      if (this.config.debugMode) {
        console.error('❌ Request conversion failed:', error);
      }

      return errorResult;
    }
  }

  /**
   * 批量转换请求
   */
  async convertBatch(
    requests: OpenAIRequest[],
    pipelineConfigs: any[],
    routingInfos: any[]
  ): Promise<BatchConversionResult> {
    this.ensureInitialized();

    if (requests.length !== pipelineConfigs.length || requests.length !== routingInfos.length) {
      throw new Error('Batch conversion requires equal number of requests, pipeline configs, and routing infos');
    }

    const startTime = Date.now();
    const successful: ConversionResult[] = [];
    const failed: any[] = [];
    const errorDistribution: Record<string, number> = {};

    for (let i = 0; i < requests.length; i++) {
      try {
        const result = await this.convertRequest(
          requests[i],
          pipelineConfigs[i],
          routingInfos[i]
        );

        if (result.success) {
          successful.push(result);
        } else {
          failed.push({
            request: requests[i],
            error: result.errors?.join(', ') || 'Unknown error',
            timestamp: new Date()
          });

          // 统计错误分布
          const errorType = result.errors?.[0] || 'unknown';
          errorDistribution[errorType] = (errorDistribution[errorType] || 0) + 1;
        }
      } catch (error) {
        failed.push({
          request: requests[i],
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date()
        });

        const errorType = error instanceof Error ? error.constructor.name : 'unknown';
        errorDistribution[errorType] = (errorDistribution[errorType] || 0) + 1;
      }
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    return {
      successful,
      failed,
      summary: {
        totalRequests: requests.length,
        successfulCount: successful.length,
        failedCount: failed.length,
        successRate: successful.length / requests.length,
        averageTime: totalTime / requests.length,
        totalTime,
        errorDistribution
      }
    };
  }

  /**
   * 简化转换方法 - 直接路由到default
   */
  async convertSimple(
    request: OpenAIRequest,
    defaultTarget: {
      providerId: string;
      modelId: string;
      keyId: string;
      pipelineConfig: any;
    }
  ): Promise<ConversionResult> {
    // 创建简化的路由信息
    const routingInfo = {
      route: 'default',
      providerId: defaultTarget.providerId,
      modelId: defaultTarget.modelId,
      keyId: defaultTarget.keyId
    };

    return this.convertRequest(request, defaultTarget.pipelineConfig, routingInfo);
  }

  /**
   * 获取转换器状态
   */
  getStatus(): ConverterStatus {
    return {
      isInitialized: this.isInitialized,
      config: this.config,
      metrics: this.getMetrics(),
      health: this.checkHealth(),
      lastConversion: this.metrics.lastConversionTime ? undefined : undefined
    };
  }

  /**
   * 获取性能指标
   */
  getMetrics(): ConverterMetrics {
    return {
      ...this.metrics,
      uptime: Date.now() - this.startTime,
      lastConversionTime: this.metrics.lastConversionTime ? new Date(this.metrics.lastConversionTime) : undefined
    };
  }

  /**
   * 健康检查
   */
  checkHealth(): HealthStatus {
    const checks = [
      {
        name: 'initialization',
        status: this.isInitialized ? 'pass' as const : 'fail' as const,
        message: this.isInitialized ? 'Converter initialized' : 'Converter not initialized'
      },
      {
        name: 'memory_usage',
        status: 'pass' as const,
        message: `Memory usage: ${Math.round(this.metrics.memoryUsage / 1024 / 1024)}MB`
      },
      {
        name: 'conversion_rate',
        status: this.metrics.totalConversions > 0 ? 'pass' as const : 'warn' as const,
        message: `Success rate: ${this.calculateSuccessRate()}%`
      }
    ];

    const overallStatus = checks.every(check => check.status === 'pass') ? 'healthy' :
                           checks.some(check => check.status === 'fail') ? 'unhealthy' : 'degraded';

    return {
      status: overallStatus,
      checks,
      lastCheck: new Date()
    };
  }

  /**
   * 重置指标
   */
  resetMetrics(): void {
    this.metrics = this.initializeMetrics();
    this.startTime = Date.now();

    if (this.config.debugMode) {
      console.log('📊 Metrics reset successfully');
    }
  }

  /**
   * 添加自定义映射规则
   */
  addModelMapping(category: string, pattern: string, targetModel: string, provider: string, priority: number = 1): void {
    this.fieldMappingRules.addModelMapping(category, {
      pattern,
      targetModel,
      provider,
      priority
    });

    if (this.config.debugMode) {
      console.log(`📋 Added model mapping: ${pattern} → ${targetModel} (${provider})`);
    }
  }

  /**
   * 获取映射规则统计
   */
  getRuleStatistics() {
    return this.fieldMappingRules.getRuleStatistics();
  }

  /**
   * 验证配置
   */
  private validateConfig(): void {
    if (this.config.traceSampling !== undefined && (this.config.traceSampling < 0 || this.config.traceSampling > 1)) {
      throw new Error('traceSampling must be between 0 and 1');
    }

    if (this.config.maxConversionDepth !== undefined && this.config.maxConversionDepth <= 0) {
      throw new Error('maxConversionDepth must be positive');
    }
  }

  /**
   * 初始化映射规则
   */
  private initializeMappingRules(): void {
    // 这里可以添加默认的映射规则
    if (this.config.debugMode) {
      console.log('📋 Mapping rules initialized');
    }
  }

  /**
   * 初始化指标
   */
  private initializeMetrics(): ConverterMetrics {
    return {
      totalConversions: 0,
      successfulConversions: 0,
      failedConversions: 0,
      averageConversionTime: 0,
      uptime: 0,
      memoryUsage: 0,
      ruleUsage: {}
    };
  }

  /**
   * 确保转换器已初始化
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Model Field Converter is not initialized. Call initialize() first.');
    }
  }

  /**
   * 更新指标
   */
  private updateMetrics(result: ConversionResult, duration: number): void {
    this.metrics.totalConversions++;
    this.metrics.memoryUsage = process.memoryUsage ? process.memoryUsage().heapUsed : 0;

    if (result.success) {
      this.metrics.successfulConversions++;
    } else {
      this.metrics.failedConversions++;
    }

    // 更新平均转换时间
    const totalTime = this.metrics.averageConversionTime * (this.metrics.totalConversions - 1) + duration;
    this.metrics.averageConversionTime = totalTime / this.metrics.totalConversions;

    // 更新规则使用统计
    if (result.debugInfo?.appliedRules) {
      for (const rule of result.debugInfo.appliedRules) {
        this.metrics.ruleUsage[rule] = (this.metrics.ruleUsage[rule] || 0) + 1;
      }
    }

    // 记录最后转换时间
    this.metrics.lastConversionTime = new Date();
  }

  /**
   * 计算成功率
   */
  private calculateSuccessRate(): number {
    if (this.metrics.totalConversions === 0) {
      return 0;
    }
    return (this.metrics.successfulConversions / this.metrics.totalConversions) * 100;
  }

  /**
   * 记录转换结果
   */
  private logConversionResult(result: ConversionResult): void {
    if (result.success) {
      console.log('✅ Request conversion successful');
      console.log('   Original model:', result.debugInfo.originalRequest.model);
      console.log('   Converted model:', result.convertedRequest.model);
      console.log('   Conversion time:', result.debugInfo.metrics.totalDuration, 'ms');
      console.log('   Steps:', result.debugInfo.metrics.totalSteps);
    } else {
      console.log('❌ Request conversion failed:', result.errors);
    }
  }

  /**
   * 生成转换ID
   */
  private generateConversionId(): string {
    return `mfc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}