/**
 * Bidirectional Pipeline Dry-Run Framework
 *
 * 扩展现有dry-run框架以支持双向流水线处理
 * 请求部分可以使用完整的dry-run实现，响应部分可以使用真实服务器响应作为输入
 */

import type {
  // PipelineModule,
  PipelineRequest,
  PipelineResponse
} from '../interfaces/pipeline-interfaces.js';
import type {
  // DryRunPipelineModule,
  NodeDryRunConfig,
  // NodeDryRunResult,
  PipelineDryRunResponse,
  // NodeDryRunContext
} from './pipeline-dry-run-framework.js';
import type { InputSimulationConfig /*, ContextPropagationData */ } from './input-simulator.js';
import { dryRunPipelineExecutor } from './dry-run-pipeline-executor.js';
import { inputSimulator } from './input-simulator.js';
import { pipelineDryRunManager } from './pipeline-dry-run-framework.js';

/**
 * 双向流水线方向
 */
export type PipelineDirection = 'request' | 'response';

/**
 * 响应dry-run配置
 */
export interface ResponseDryRunConfig {
  /** 是否启用响应dry-run */
  enabled: boolean;
  /** 响应输入源 */
  inputSource: 'real-response' | 'simulated-response' | 'cached-response';
  /** 响应转换规则 */
  transformationRules?: ResponseTransformationRule[];
  /** 响应验证规则 */
  validationRules?: ResponseValidationRule[];
  /** 响应性能分析 */
  performanceAnalysis: boolean;
  /** 响应缓存配置 */
  caching?: ResponseCachingConfig;
}

/**
 * 响应转换规则
 */
export interface ResponseTransformationRule {
  /** 规则ID */
  id: string;
  /** 转换类型 */
  type: 'format' | 'protocol' | 'content' | 'metadata';
  /** 转换条件 */
  condition: any;
  /** 转换操作 */
  transformation: any;
  /** 优先级 */
  priority: number;
}

/**
 * 响应验证规则
 */
export interface ResponseValidationRule {
  /** 规则ID */
  id: string;
  /** 验证类型 */
  type: 'schema' | 'format' | 'content' | 'performance';
  /** 验证条件 */
  condition: any;
  /** 错误消息 */
  errorMessage: string;
  /** 严重级别 */
  severity: 'warning' | 'error' | 'critical';
}

/**
 * 响应缓存配置
 */
export interface ResponseCachingConfig {
  /** 是否启用缓存 */
  enabled: boolean;
  /** 缓存大小 */
  maxSize: number;
  /** 缓存TTL */
  ttlMs: number;
  /** 缓存键生成策略 */
  keyStrategy: 'request-id' | 'content-hash' | 'custom';
}

/**
 * 双向流水线配置
 */
export interface BidirectionalPipelineConfig {
  /** 请求流水线配置 */
  requestConfig: {
    dryRunMode: 'full' | 'partial' | 'none';
    nodeConfigs: Record<string, NodeDryRunConfig>;
    inputSimulation?: InputSimulationConfig;
  };
  /** 响应流水线配置 */
  responseConfig: {
    dryRunMode: 'full' | 'partial' | 'none';
    responseDryRun: ResponseDryRunConfig;
    nodeConfigs: Record<string, NodeDryRunConfig>;
  };
  /** 驱动器反馈配置 */
  driverFeedback: {
    enabled: boolean;
    feedbackDelayMs: number;
    analysisLevel: 'basic' | 'detailed' | 'comprehensive';
  };
}

/**
 * 响应数据
 */
export interface ResponseData {
  /** 原始响应 */
  rawResponse: any;
  /** 处理后的响应 */
  processedResponse: any;
  /** 响应元数据 */
  metadata: {
    timestamp: number;
    processingTime: number;
    source: 'real' | 'simulated' | 'cached';
    transformations: string[];
  };
}

/**
 * 双向流水线执行结果
 */
export interface BidirectionalPipelineResult {
  /** 请求流水线结果 */
  requestResult: PipelineResponse | PipelineDryRunResponse;
  /** 响应流水线结果 */
  responseResult: PipelineResponse | PipelineDryRunResponse;
  /** 驱动器反馈分析 */
  driverFeedbackAnalysis?: DriverFeedbackAnalysis;
  /** 整体执行摘要 */
  executionSummary: {
    totalExecutionTime: number;
    requestTime: number;
    responseTime: number;
    feedbackTime: number;
    mode: 'full-dry-run' | 'partial-dry-run' | 'mixed-mode' | 'normal-execution';
  };
}

/**
 * 驱动器反馈分析
 */
export interface DriverFeedbackAnalysis {
  /** 请求-响应关联分析 */
  requestResponseCorrelation: {
    correlationId: string;
    similarity: number;
    transformationPath: string[];
  };
  /** 性能分析 */
  performanceAnalysis: {
    requestProcessingTime: number;
    responseProcessingTime: number;
    totalOverhead: number;
    bottlenecks: string[];
  };
  /** 质量分析 */
  qualityAnalysis: {
    requestQuality: number;
    responseQuality: number;
    overallQuality: number;
    issues: string[];
  };
  /** 优化建议 */
  recommendations: {
    routing: string[];
    performance: string[];
    reliability: string[];
  };
}

/**
 * 双向流水线管理器
 */
export class BidirectionalPipelineManager {
  private config: BidirectionalPipelineConfig;
  private responseCache: Map<string, { data: ResponseData; timestamp: number }> = new Map();
  private activeExecutions: Map<string, BidirectionalPipelineResult> = new Map();

  constructor(config: BidirectionalPipelineConfig) {
    this.config = config;
  }

  /**
   * 执行双向流水线
   */
  async executeBidirectionalPipeline(
    request: PipelineRequest,
    pipelineId: string,
    realResponse?: any
  ): Promise<BidirectionalPipelineResult> {
    const startTime = Date.now();
    const executionId = `${pipelineId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // 执行请求流水线
      const requestResult = await this.executeRequestPipeline(request, pipelineId);
      const requestTime = Date.now() - startTime;

      // 准备响应数据
      const responseData = await this.prepareResponseData(realResponse, request, executionId);
      const responsePrepTime = Date.now() - startTime - requestTime;

      // 执行响应流水线
      const responseResult = await this.executeResponsePipeline(responseData, `${pipelineId}_response`);
      const responseTime = Date.now() - startTime - requestTime - responsePrepTime;

      // 执行驱动器反馈分析
      let driverFeedbackAnalysis: DriverFeedbackAnalysis | undefined;
      let feedbackTime = 0;

      if (this.config.driverFeedback.enabled) {
        const feedbackStart = Date.now();
        driverFeedbackAnalysis = await this.performDriverFeedbackAnalysis(
          requestResult,
          responseResult,
          request,
          responseData
        );
        feedbackTime = Date.now() - feedbackStart;
      }

      // 组装执行结果
      const result: BidirectionalPipelineResult = {
        requestResult,
        responseResult,
        driverFeedbackAnalysis,
        executionSummary: {
          totalExecutionTime: Date.now() - startTime,
          requestTime,
          responseTime,
          feedbackTime,
          mode: this.determineExecutionMode()
        }
      };

      // 缓存执行结果
      this.activeExecutions.set(executionId, result);

      return result;

    } catch (error) {
      console.error(`Bidirectional pipeline execution failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 执行请求流水线
   */
  private async executeRequestPipeline(
    request: PipelineRequest,
    pipelineId: string
  ): Promise<PipelineResponse | PipelineDryRunResponse> {
    const { dryRunMode, nodeConfigs /*, inputSimulation */ } = this.config.requestConfig;

    if (dryRunMode === 'none') {
      // 正常执行请求流水线
      return this.executeNormalRequestPipeline(request, pipelineId);
    }

    // 配置节点dry-run
    pipelineDryRunManager.configureNodesDryRun(nodeConfigs);

    // 确定执行模式
    const mode = dryRunMode === 'full' ? 'dry-run' : 'mixed';

    // 执行dry-run
    return dryRunPipelineExecutor.executePipeline(request, pipelineId, mode);
  }

  /**
   * 执行正常请求流水线
   */
  private async executeNormalRequestPipeline(
    request: PipelineRequest,
    pipelineId: string
  ): Promise<PipelineResponse> {
    // 这里应该调用正常的流水线执行逻辑
    // 暂时返回一个模拟的正常响应
    return {
      data: { message: 'Normal request execution completed' },
      metadata: {
        pipelineId,
        processingTime: 100,
        stages: ['request-processing'],
        errors: []
      }
    };
  }

  /**
   * 准备响应数据
   */
  private async prepareResponseData(
    realResponse: any,
    request: PipelineRequest,
    executionId: string
  ): Promise<ResponseData> {
    const { inputSource, caching } = this.config.responseConfig.responseDryRun;
    // const startTime = Date.now();

    // 检查缓存
    if (caching?.enabled) {
      const cacheKey = this.generateCacheKey(request, executionId, caching.keyStrategy || 'request-id');
      const cached = this.responseCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < caching.ttlMs) {
        return cached.data;
      }
    }

    let responseData: ResponseData;

    switch (inputSource) {
      case 'real-response':
        if (!realResponse) {
          throw new Error('Real response is required but not provided');
        }
        responseData = await this.processRealResponse(realResponse, request);
        break;

      case 'simulated-response':
        responseData = await this.generateSimulatedResponse(request);
        break;

      case 'cached-response':
        responseData = await this.getCachedResponse(request);
        break;

      default:
        throw new Error(`Unknown response input source: ${inputSource}`);
    }

    // 缓存响应数据
    if (caching?.enabled) {
      const cacheKey = this.generateCacheKey(request, executionId, caching.keyStrategy || 'request-id');
      this.responseCache.set(cacheKey, { data: responseData, timestamp: Date.now() });

      // 清理过期缓存
      this.cleanExpiredCache(caching.maxSize);
    }

    return responseData;
  }

  /**
   * 处理真实响应
   */
  private async processRealResponse(
    realResponse: any,
    _request: PipelineRequest
  ): Promise<ResponseData> {
    const processingStart = Date.now();

    // 应用转换规则
    let processedResponse = realResponse;
    const transformations: string[] = [];

    if (this.config.responseConfig.responseDryRun.transformationRules) {
      for (const rule of this.config.responseConfig.responseDryRun.transformationRules) {
        if (this.matchesCondition(realResponse, rule.condition)) {
          processedResponse = this.applyTransformation(processedResponse, rule.transformation);
          transformations.push(rule.id);
        }
      }
    }

    return {
      rawResponse: realResponse,
      processedResponse,
      metadata: {
        timestamp: Date.now(),
        processingTime: Date.now() - processingStart,
        source: 'real',
        transformations
      }
    };
  }

  /**
   * 生成模拟响应
   */
  private async generateSimulatedResponse(request: PipelineRequest): Promise<ResponseData> {
    const processingStart = Date.now();

    // 使用输入模拟器生成模拟响应
    const simulatedData = await inputSimulator.simulateInput(
      request,
      'response-generator',
      'response-processor',
      {
        nodeOutputs: new Map(),
        dataFlowPath: [],
        transformationHistory: [],
        executionContext: {
          requestId: request.route.requestId,
          pipelineId: 'simulated-response',
          originalRequest: request
        }
      },
      {
        enabled: true,
        primaryStrategy: 'ai-generation',
        fallbackStrategies: ['rule-based', 'schema-inference'],
        qualityRequirement: 'medium',
        useHistoricalData: false,
        enableSmartInference: true
      }
    );

    return {
      rawResponse: simulatedData.data,
      processedResponse: simulatedData.data,
      metadata: {
        timestamp: Date.now(),
        processingTime: Date.now() - processingStart,
        source: 'simulated',
        transformations: ['ai-generated']
      }
    };
  }

  /**
   * 获取缓存的响应
   */
  private async getCachedResponse(_request: PipelineRequest): Promise<ResponseData> {
    // 从历史数据中查找类似的响应
    const historicalResponses = this.findHistoricalResponses(_request);

    if (historicalResponses.length > 0) {
      const bestMatch = historicalResponses[0];
      return {
        rawResponse: bestMatch.rawResponse,
        processedResponse: bestMatch.processedResponse,
        metadata: {
          timestamp: Date.now(),
          processingTime: 5, // 缓存查找很快
          source: 'cached',
          transformations: bestMatch.metadata.transformations
        }
      };
    }

    // 如果没有缓存，生成模拟响应
    return this.generateSimulatedResponse(_request);
  }

  /**
   * 执行响应流水线
   */
  private async executeResponsePipeline(
    responseData: ResponseData,
    pipelineId: string
  ): Promise<PipelineResponse | PipelineDryRunResponse> {
    const { dryRunMode, nodeConfigs } = this.config.responseConfig;

    if (dryRunMode === 'none') {
      // 正常执行响应流水线
      return {
        success: true,
        data: responseData.processedResponse,
        metadata: {
          pipelineId,
          processingTime: responseData.metadata.processingTime,
          stages: ['response-processing'],
          errors: []
        }
      };
    }

    // 配置节点dry-run
    pipelineDryRunManager.configureNodesDryRun(nodeConfigs);

    // 构造响应流水线请求
    const responsePipelineRequest: PipelineRequest = {
      data: responseData.processedResponse,
      route: {
        providerId: 'response-processor',
        modelId: 'response-model',
        requestId: `response_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {
        source: responseData.metadata.source,
        transformations: responseData.metadata.transformations,
        processingTime: responseData.metadata.processingTime
      },
      debug: { enabled: false, stages: {} }
    };

    // 执行dry-run
    const mode = dryRunMode === 'full' ? 'dry-run' : 'mixed';
    return dryRunPipelineExecutor.executePipeline(responsePipelineRequest, pipelineId, mode);
  }

  /**
   * 执行驱动器反馈分析
   */
  private async performDriverFeedbackAnalysis(
    requestResult: any,
    responseResult: any,
    originalRequest: PipelineRequest,
    responseData: ResponseData
  ): Promise<DriverFeedbackAnalysis> {
    const { analysisLevel } = this.config.driverFeedback;

    // 请求-响应关联分析
    const correlationAnalysis = this.analyzeRequestResponseCorrelation(
      originalRequest,
      responseData,
      analysisLevel
    );

    // 性能分析
    const performanceAnalysis = this.analyzePerformance(
      requestResult,
      responseResult,
      responseData,
      analysisLevel
    );

    // 质量分析
    const qualityAnalysis = this.analyzeQuality(
      requestResult,
      responseResult,
      analysisLevel
    );

    // 生成优化建议
    const recommendations = this.generateRecommendations(
      correlationAnalysis,
      performanceAnalysis,
      qualityAnalysis,
      analysisLevel
    );

    return {
      requestResponseCorrelation: correlationAnalysis,
      performanceAnalysis,
      qualityAnalysis,
      recommendations
    };
  }

  /**
   * 分析请求-响应关联
   */
  private analyzeRequestResponseCorrelation(
    request: PipelineRequest,
    responseData: ResponseData,
    analysisLevel: string
  ): any {
    // 基础关联分析
    const correlationId = `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 计算相似度（简化版）
    const similarity = this.calculateSimilarity(request.data, responseData.processedResponse);

    // 分析转换路径
    const transformationPath = responseData.metadata.transformations;

    return {
      correlationId,
      similarity,
      transformationPath,
      analysisLevel
    };
  }

  /**
   * 分析性能
   */
  private analyzePerformance(
    requestResult: any,
    responseResult: any,
    responseData: ResponseData,
    analysisLevel: string
  ): any {
    const requestProcessingTime = this.extractProcessingTime(requestResult);
    const responseProcessingTime = responseData.metadata.processingTime;
    const totalOverhead = requestProcessingTime + responseProcessingTime;

    const bottlenecks: string[] = [];

    if (requestProcessingTime > 1000) {
      bottlenecks.push('request-processing');
    }

    if (responseProcessingTime > 1000) {
      bottlenecks.push('response-processing');
    }

    return {
      requestProcessingTime,
      responseProcessingTime,
      totalOverhead,
      bottlenecks,
      analysisLevel
    };
  }

  /**
   * 分析质量
   */
  private analyzeQuality(
    requestResult: any,
    responseResult: any,
    analysisLevel: string
  ): any {
    // 简化的质量分析
    const requestQuality = this.calculateQualityScore(requestResult);
    const responseQuality = this.calculateQualityScore(responseResult);
    const overallQuality = (requestQuality + responseQuality) / 2;

    const issues: string[] = [];

    if (requestQuality < 0.7) {
      issues.push('low-request-quality');
    }

    if (responseQuality < 0.7) {
      issues.push('low-response-quality');
    }

    return {
      requestQuality,
      responseQuality,
      overallQuality,
      issues,
      analysisLevel
    };
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(
    correlation: any,
    performance: any,
    quality: any,
    _analysisLevel: string
  ): any {
    const routing: string[] = [];
    const performanceRecs: string[] = [];
    const reliability: string[] = [];

    // 基于分析结果生成建议
    if (performance.totalOverhead > 2000) {
      performanceRecs.push('Consider optimizing processing time');
    }

    if (quality.overallQuality < 0.8) {
      reliability.push('Improve data quality validation');
    }

    if (correlation.similarity < 0.5) {
      routing.push('Review request-response mapping');
    }

    return {
      routing,
      performance: performanceRecs,
      reliability
    };
  }

  /**
   * 辅助方法
   */
  private determineExecutionMode(): 'full-dry-run' | 'partial-dry-run' | 'mixed-mode' | 'normal-execution' {
    const requestDryRun = this.config.requestConfig.dryRunMode !== 'none';
    const responseDryRun = this.config.responseConfig.dryRunMode !== 'none';

    if (requestDryRun && responseDryRun) {
      return 'full-dry-run';
    } else if (requestDryRun || responseDryRun) {
      return 'partial-dry-run';
    } else {
      return 'normal-execution';
    }
  }

  private generateCacheKey(request: PipelineRequest, executionId: string, strategy: string): string {
    switch (strategy) {
      case 'request-id':
        return request.route.requestId;
      case 'content-hash':
        return this.hashContent(JSON.stringify(request.data));
      case 'custom':
        return `${executionId}_custom`;
      default:
        return executionId;
    }
  }

  private hashContent(content: string): string {
    // 简化的哈希函数
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return hash.toString(36);
  }

  private cleanExpiredCache(maxSize: number) {
    if (this.responseCache.size > maxSize) {
      // 删除最旧的条目
      const oldestKey = this.responseCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this.responseCache.delete(oldestKey);
      }
    }
  }

  private matchesCondition(_data: any, _condition: any): boolean {
    // 简化的条件匹配
    return true;
  }

  private applyTransformation(data: any, _transformation: any): any {
    // 简化的转换应用
    return { ...data, transformed: true };
  }

  private findHistoricalResponses(_request: PipelineRequest): ResponseData[] {
    // 简化的历史响应查找
    return [];
  }

  private calculateSimilarity(_request: any, _response: any): number {
    // 简化的相似度计算
    return 0.8;
  }

  private extractProcessingTime(_result: any): number {
    // 提取处理时间
    // if (result && result.metadata && result.metadata.processingTime) {
    //   return result.metadata.processingTime;
    // }
    return 100; // 默认值
  }

  private calculateQualityScore(_result: any): number {
    // 简化的质量评分
    return 0.85;
  }

  /**
   * 获取执行结果
   */
  getExecutionResult(executionId: string): BidirectionalPipelineResult | undefined {
    return this.activeExecutions.get(executionId);
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.responseCache.clear();
    this.activeExecutions.clear();
  }
}

/**
 * 默认双向流水线配置
 */
export const defaultBidirectionalConfig: BidirectionalPipelineConfig = {
  requestConfig: {
    dryRunMode: 'partial',
    nodeConfigs: {
      'llm-switch': {
        enabled: true,
        mode: 'output-validation',
        breakpointBehavior: 'continue',
        verbosity: 'normal'
      },
      'compatibility': {
        enabled: false,
        mode: 'output-validation',
        breakpointBehavior: 'continue',
        verbosity: 'minimal'
      }
    },
    inputSimulation: {
      enabled: true,
      primaryStrategy: 'historical-data',
      fallbackStrategies: ['schema-inference', 'rule-based'],
      qualityRequirement: 'medium',
      useHistoricalData: true,
      enableSmartInference: true
    }
  },
  responseConfig: {
    dryRunMode: 'partial',
    responseDryRun: {
      enabled: true,
      inputSource: 'real-response',
      performanceAnalysis: true,
      caching: {
        enabled: true,
        maxSize: 100,
        ttlMs: 300000, // 5分钟
        keyStrategy: 'request-id'
      }
    },
    nodeConfigs: {
      'response-processor': {
        enabled: true,
        mode: 'output-validation',
        breakpointBehavior: 'continue',
        verbosity: 'normal'
      }
    }
  },
  driverFeedback: {
    enabled: true,
    feedbackDelayMs: 100,
    analysisLevel: 'detailed'
  }
};

/**
 * 导出双向流水线管理器
 */
export const bidirectionalPipelineManager = new BidirectionalPipelineManager(defaultBidirectionalConfig);
