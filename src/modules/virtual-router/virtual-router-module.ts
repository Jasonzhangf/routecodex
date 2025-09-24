/**
 * Virtual Router Module
 * 虚拟路由模块 - 处理请求路由和负载均衡
 */

import { BaseModule } from '../../core/base-module.js';
import { ModelFieldConverter } from '../../utils/model-field-converter/index.js';
import { RCCUnimplementedModule } from '../../modules/unimplemented-module.js';
import { ConfigRequestClassifier } from './classifiers/config-request-classifier.js';
import type { ModelCategoryConfig } from './classifiers/model-category-resolver.js';
import type {
  RouteTargetPool,
  PipelineConfigs,
  VirtualRouterConfig,
  RouteTarget,
  PipelineConfig
} from '../../config/merged-config-types.js';
import { DebugEventBus } from '../../utils/external-mocks.js';

export class VirtualRouterModule extends BaseModule {
  private routeTargets: RouteTargetPool = {};
  private pipelineConfigs: PipelineConfigs = {};
  private protocolManager: ProtocolManager;
  private loadBalancer: LoadBalancer;
  private fieldConverter: ModelFieldConverter;
  private unimplementedModule: RCCUnimplementedModule;
  private configRequestClassifier: ConfigRequestClassifier | null = null;

  // Debug enhancement properties - now inherited from BaseModule
  private routingMetrics: Map<string, any> = new Map();
  private performanceMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  // maxHistorySize is now inherited from BaseModule
  private classificationStats: Map<string, any> = new Map();

  constructor() {
    super({
      id: 'virtual-router',
      name: 'Virtual Router',
      version: '2.0.0',
      description: 'Handles request routing, load balancing and field conversion'
    });

    this.protocolManager = new ProtocolManager();
    this.loadBalancer = new LoadBalancer();
    this.fieldConverter = new ModelFieldConverter({ debugMode: true });
    this.unimplementedModule = new RCCUnimplementedModule({
      moduleId: 'virtual-router-mock',
      moduleName: 'Virtual Router Mock Handler',
      description: 'Handles unimplemented model requests with detailed debugging'
    });

    // Debug enhancements are now initialized in BaseModule constructor
  }

  /**
   * 初始化模块
   */
  async initialize(config: VirtualRouterConfig): Promise<void> {
    console.log('🔄 Initializing Virtual Router Module v2.0...');

    try {
      // 设置路由目标池
      this.routeTargets = config.routeTargets;

      // 设置流水线配置
      this.pipelineConfigs = config.pipelineConfigs;

      // 初始化配置驱动的请求分类器
      await this.initializeConfigRequestClassifier();

      // 从配置中提取默认值
      const defaultConfig = this.extractDefaultConfig();

      // 初始化字段转换器
      await this.fieldConverter.initialize({
        debugMode: true,
        enableTracing: true,
        defaultMaxTokens: defaultConfig.defaultMaxTokens,
        defaultModel: defaultConfig.defaultModel,
        pipelineConfigs: this.pipelineConfigs
      });

      // 初始化unimplemented模块
      await this.unimplementedModule.initialize();

      // 初始化协议管理器
      await this.protocolManager.initialize({
        inputProtocol: config.inputProtocol,
        outputProtocol: config.outputProtocol
      });

      // 初始化负载均衡器
      await this.loadBalancer.initialize(this.routeTargets);

      console.log('✅ Virtual Router Module v2.0 initialized successfully');
      console.log('📊 Available routes:', Object.keys(this.routeTargets));
      console.log('📋 Pipeline configs:', Object.keys(this.pipelineConfigs).length);
    } catch (error) {
      console.error('❌ Failed to initialize Virtual Router Module:', error);
      throw error;
    }
  }

  /**
   * 初始化配置驱动的请求分类器
   */
  private async initializeConfigRequestClassifier(): Promise<void> {
    try {
      // 加载分类配置
      const classificationConfig = await this.loadClassificationConfig();

      // 创建配置驱动的请求分类器
      this.configRequestClassifier = ConfigRequestClassifier.fromModuleConfig(classificationConfig);

      console.log('✅ Config-driven Request Classifier initialized successfully');
    } catch (error) {
      console.warn('⚠️ Failed to initialize Config-driven Request Classifier:', error);
      console.log('🔄 Falling back to default routing behavior');
      this.configRequestClassifier = null;
    }
  }

  /**
   * 加载分类配置
   */
  private async loadClassificationConfig(): Promise<any> {
    try {
      // 这里可以从模块配置中加载，现在使用默认配置
      const defaultConfig = {
        protocolMapping: {
          openai: {
            endpoints: ['/v1/chat/completions', '/v1/completions'],
            messageField: 'messages',
            modelField: 'model',
            toolsField: 'tools',
            maxTokensField: 'max_tokens'
          },
          anthropic: {
            endpoints: ['/v1/messages'],
            messageField: 'messages',
            modelField: 'model',
            toolsField: 'tools',
            maxTokensField: 'max_tokens'
          }
        },
        protocolHandlers: {
          openai: {
            tokenCalculator: {
              type: 'openai',
              tokenRatio: 0.25,
              toolOverhead: 50,
              messageOverhead: 10,
              imageTokenDefault: 255
            },
            toolDetector: {
              type: 'pattern',
              patterns: {
                webSearch: ['web_search', 'search', 'browse', 'internet'],
                codeExecution: ['code', 'execute', 'bash', 'python', 'javascript'],
                fileSearch: ['file', 'read', 'write', 'document', 'pdf'],
                dataAnalysis: ['data', 'analysis', 'chart', 'graph', 'statistics']
              }
            }
          },
          anthropic: {
            tokenCalculator: {
              type: 'anthropic',
              tokenRatio: 0.25,
              toolOverhead: 50,
              messageOverhead: 10
            },
            toolDetector: {
              type: 'pattern',
              patterns: {
                webSearch: ['web_search', 'search', 'browse'],
                codeExecution: ['code', 'execute', 'bash', 'python'],
                fileSearch: ['file', 'read', 'write'],
                dataAnalysis: ['data', 'analysis', 'chart']
              }
            }
          }
        },
        modelTiers: {
          basic: {
            description: 'Basic models for simple tasks',
            models: ['gpt-3.5-turbo', 'claude-3-haiku', 'qwen-turbo'],
            maxTokens: 16384,
            supportedFeatures: ['text_generation', 'conversation']
          },
          advanced: {
            description: 'Advanced models for complex tasks',
            models: ['gpt-4', 'claude-3-opus', 'claude-3-sonnet', 'deepseek-coder', 'qwen-max'],
            maxTokens: 262144,
            supportedFeatures: ['text_generation', 'reasoning', 'coding', 'tool_use']
          }
        },
        routingDecisions: {
          default: {
            description: 'Default routing for general requests',
            modelTier: 'basic',
            tokenThreshold: 8000,
            toolTypes: [],
            priority: 1
          },
          longContext: {
            description: 'Routing for long context requests',
            modelTier: 'advanced',
            tokenThreshold: 32000,
            toolTypes: [],
            priority: 90
          },
          thinking: {
            description: 'Routing for complex reasoning requests',
            modelTier: 'advanced',
            tokenThreshold: 16000,
            toolTypes: ['dataAnalysis', 'complex_reasoning'],
            priority: 85
          },
          coding: {
            description: 'Routing for code generation requests',
            modelTier: 'advanced',
            tokenThreshold: 24000,
            toolTypes: ['codeExecution', 'fileSearch'],
            priority: 80
          },
          webSearch: {
            description: 'Routing for web search requests',
            modelTier: 'advanced',
            tokenThreshold: 12000,
            toolTypes: ['webSearch'],
            priority: 95
          }
        },
        confidenceThreshold: 60
      };

      return defaultConfig;
    } catch (error) {
      console.error('Failed to load classification config:', error);
      throw error;
    }
  }

  /**
   * 智能路由请求 - 使用分类器动态决定路由
   */
  async routeRequest(request: any, routeName: string = 'default'): Promise<any> {
    const startTime = Date.now();
    const requestId = `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      console.log('🔄 Starting smart request routing...');
      console.log('📝 Original request:', { model: request.model, initialRoute: routeName });

      // Debug: Record request start
      if (this.isDebugEnhanced) {
        this.recordRoutingMetric('request_start', {
          requestId,
          routeName,
          model: request.model,
          timestamp: startTime
        });
        this.publishDebugEvent('routing_start', {
          requestId,
          originalRequest: { model: request.model, initialRoute: routeName },
          routeName
        });
      }

      // 使用配置驱动的分类器进行智能路由
      if (this.configRequestClassifier) {
        const classificationResult = await this.classifyRequestWithConfig(request);
        routeName = classificationResult.route;

        console.log('🎯 Config-driven classification result:', {
          route: classificationResult.route,
          modelTier: classificationResult.modelTier,
          confidence: classificationResult.confidence,
          reasoning: classificationResult.reasoning,
          configBased: classificationResult.configBased
        });

        // Debug: Record classification metrics
        if (this.isDebugEnhanced) {
          this.recordClassificationMetric(classificationResult.route, {
            confidence: classificationResult.confidence,
            modelTier: classificationResult.modelTier,
            configBased: classificationResult.configBased,
            reasoning: classificationResult.reasoning
          });
          this.publishDebugEvent('classification_complete', {
            requestId,
            classificationResult,
            processingTime: Date.now() - startTime
          });
        }

        // 验证路由是否可用
        if (!this.routeTargets[routeName]) {
          console.warn(`⚠️ Route '${routeName}' not available, falling back to default`);
          routeName = 'default';
        }
      } else {
        console.log('🔄 No config-driven classifier available, using default routing');
        routeName = 'default';
      }

      // 获取可用目标
      const targets = this.routeTargets[routeName];
      if (!targets || targets.length === 0) {
        throw new Error(`No targets found for route: ${routeName}`);
      }

      console.log('🎯 Available targets:', targets.length);

      // 选择目标（使用负载均衡）
      const target = await this.loadBalancer.selectTarget(targets, routeName, request);
      if (!target) {
        throw new Error('No available targets for routing');
      }

      console.log('🎯 Selected target:', {
        providerId: target.providerId,
        modelId: target.modelId,
        keyId: target.keyId
      });

      // Debug: Record target selection
      if (this.isDebugEnhanced) {
        this.recordRoutingMetric('target_selected', {
          requestId,
          target: {
            providerId: target.providerId,
            modelId: target.modelId,
            keyId: target.keyId
          },
          routeName,
          selectionTime: Date.now() - startTime
        });
        this.publishDebugEvent('target_selected', {
          requestId,
          target,
          routeName,
          processingTime: Date.now() - startTime
        });
      }

      // 获取流水线配置
      const pipelineConfigKey = `${target.providerId}.${target.modelId}.${target.keyId}`;
      const pipelineConfig = this.pipelineConfigs[pipelineConfigKey];
      if (!pipelineConfig) {
        throw new Error(`No pipeline config found for target: ${pipelineConfigKey}`);
      }

      console.log('⚙️ Pipeline config found for:', pipelineConfigKey);

      // 构建路由信息
      const routingInfo = {
        route: routeName,
        providerId: target.providerId,
        modelId: target.modelId,
        keyId: target.keyId,
        selectedTarget: target,
        selectionTime: Date.now()
      };

      // 使用字段转换器转换请求
      console.log('🔄 Converting request fields...');
      const conversionResult = await this.fieldConverter.convertRequest(
        request,
        pipelineConfig,
        routingInfo
      );

      if (!conversionResult.success) {
        console.error('❌ Request field conversion failed:', conversionResult.errors);
        throw new Error(`Field conversion failed: ${conversionResult.errors?.join(', ')}`);
      }

      console.log('✅ Request field conversion successful');
      console.log('📝 Converted request:', {
        model: conversionResult.convertedRequest.model,
        max_tokens: conversionResult.convertedRequest.max_tokens,
        originalModel: conversionResult.debugInfo.originalRequest.model
      });

      // Debug: Record conversion completion
      if (this.isDebugEnhanced) {
        this.recordRoutingMetric('conversion_complete', {
          requestId,
          conversionSuccess: conversionResult.success,
          conversionTime: Date.now() - startTime,
          debugInfo: conversionResult.debugInfo
        });
        this.publishDebugEvent('conversion_complete', {
          requestId,
          conversionResult,
          processingTime: Date.now() - startTime
        });
      }

      // 使用unimplemented模块处理mock响应
      console.log('🎭 Using unimplemented module for mock response...');

      const mockResponse = await this.unimplementedModule.handleUnimplementedCall(
        'model-request-execution',
        {
          callerId: 'virtual-router',
          context: {
            originalRequest: request,
            convertedRequest: conversionResult.convertedRequest,
            routingInfo: routingInfo,
            pipelineConfig: pipelineConfig,
            conversionDebugInfo: conversionResult.debugInfo,
            target: target,
            timestamp: new Date().toISOString()
          }
        }
      );

      // 将routingInfo添加到响应中
      const responseWithRouting = {
        ...mockResponse,
        routingInfo: routingInfo,
        convertedRequest: conversionResult.convertedRequest
      };

      console.log('✅ Mock response generated successfully');

      // Debug: Record request completion
      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordRoutingMetric('request_complete', {
          requestId,
          routeName,
          success: true,
          totalTime,
          routingInfo
        });
        this.addToRequestHistory({
          requestId,
          routeName,
          target: routingInfo.selectedTarget,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true
        });
        this.publishDebugEvent('routing_complete', {
          requestId,
          responseWithRouting,
          totalTime,
          success: true
        });
      }

      return responseWithRouting;

    } catch (error) {
      console.error(`❌ Request routing failed for route ${routeName}:`, error);

      // Debug: Record error
      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordRoutingMetric('request_error', {
          requestId,
          routeName,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToRequestHistory({
          requestId,
          routeName,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
        this.publishDebugEvent('routing_error', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          routeName,
          totalTime
        });
      }

      // 即使出错也返回unimplemented响应以保持一致性
      try {
        const errorResponse = await this.unimplementedModule.handleUnimplementedCall(
          'routing-error',
          {
            callerId: 'virtual-router',
            context: {
              error: error instanceof Error ? error.message : String(error),
              routeName,
              timestamp: new Date().toISOString()
            }
          }
        );

        // 添加基本的routingInfo到错误响应
        return {
          ...errorResponse,
          routingInfo: {
            route: routeName,
            providerId: 'error',
            modelId: 'error',
            keyId: 'error',
            error: error instanceof Error ? error.message : String(error)
          }
        };
      } catch (fallbackError) {
        // 如果unimplemented模块也失败，返回基本错误响应
        return {
          error: {
            message: `Routing failed: ${error instanceof Error ? error.message : String(error)}`,
            type: 'routing_error',
            code: 500
          },
          routingInfo: {
            route: routeName,
            providerId: 'error',
            modelId: 'error',
            keyId: 'error',
            error: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
  }

  /**
   * 执行请求 - 已弃用，现在使用unimplemented模块
   * @deprecated Use unimplemented module instead
   */
  private async executeRequest(request: any, pipelineConfig: PipelineConfig): Promise<any> {
    console.warn('⚠️ executeRequest is deprecated, use unimplemented module instead');

    // 向后兼容，调用unimplemented模块
    return this.unimplementedModule.handleUnimplementedCall(
      'deprecated-execute-request',
      {
        callerId: 'virtual-router',
        context: {
          request,
          pipelineConfig,
          message: 'This method is deprecated, use routeRequest instead'
        }
      }
    );
  }

  /**
   * 从配置中提取默认值
   */
  private extractDefaultConfig(): { defaultMaxTokens: number; defaultModel: string } {
    const pipelineConfigKeys = Object.keys(this.pipelineConfigs);

    if (pipelineConfigKeys.length === 0) {
      console.log('⚠️ No pipeline configs found, using hardcoded defaults');
      return { defaultMaxTokens: 32000, defaultModel: 'qwen3-coder-plus' };
    }

    // 从第一个配置键中提取默认值 (格式: provider.model.keyId)
    const firstConfigKey = pipelineConfigKeys[0];
    const firstConfig = this.pipelineConfigs[firstConfigKey];
    const defaultMaxTokens = firstConfig.model?.maxTokens || 32000;

    // 从配置键中提取模型ID
    const keyParts = firstConfigKey.split('.');
    let defaultModel = 'qwen3-coder-plus';
    if (keyParts.length >= 2) {
      defaultModel = keyParts[1]; // modelId 部分
    }

    console.log(`🔧 Extracted default config from pipeline: maxTokens=${defaultMaxTokens}, model=${defaultModel}`);

    return { defaultMaxTokens, defaultModel };
  }

  /**
   * 获取状态
   */
  getStatus(): any {
    return {
      status: this.isRunning ? 'running' : 'stopped',
      routeTargets: Object.keys(this.routeTargets),
      pipelineConfigs: Object.keys(this.pipelineConfigs),
      protocolManager: this.protocolManager.getStatus(),
      loadBalancer: this.loadBalancer.getStatus()
    };
  }
  /**
   * 使用配置驱动的分类器执行分类
   */
  private async classifyRequestWithConfig(request: any): Promise<any> {
    if (!this.configRequestClassifier) {
      return {
        route: 'default',
        modelTier: 'basic',
        confidence: 50,
        reasoning: 'No config-driven classifier available',
        configBased: false
      };
    }

    try {
      // 准备分类输入
      const classificationInput = {
        request: request,
        endpoint: request.endpoint || '/v1/chat/completions',
        protocol: request.protocol || 'openai',
        userPreferences: request.userPreferences
      };

      // 执行分类
      const classificationResult = await this.configRequestClassifier.classify(classificationInput);

      console.log('🧠 Config-driven classification completed:', {
        route: classificationResult.route,
        modelTier: classificationResult.modelTier,
        confidence: classificationResult.confidence,
        factors: classificationResult.factors,
        recommendations: classificationResult.recommendations,
        performance: classificationResult.performance
      });

      return classificationResult;

    } catch (error) {
      console.error('❌ Config-driven classification failed:', error);
      return {
        route: 'default',
        modelTier: 'basic',
        confidence: 30,
        reasoning: `Config-driven classification failed: ${error instanceof Error ? error.message : String(error)}`,
        configBased: false
      };
    }
  }

  /**
   * 获取配置驱动的分类器状态
   */
  getConfigClassifierStatus(): {
    enabled: boolean;
    configBased: boolean;
    status: any;
    protocols: string[];
    validation: any;
  } {
    if (!this.configRequestClassifier) {
      return {
        enabled: false,
        configBased: false,
        status: null,
        protocols: [],
        validation: null
      };
    }

    const status = this.configRequestClassifier.getStatus();

    return {
      enabled: true,
      configBased: true,
      status,
      protocols: status.protocols,
      validation: status.configValidation
    };
  }

  /**
   * Record routing metric
   */
  public recordRoutingMetric(operation: string, data: any): void {
    if (!this.routingMetrics.has(operation)) {
      this.routingMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.routingMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Record classification metric
   */
  private recordClassificationMetric(route: string, data: any): void {
    if (!this.classificationStats.has(route)) {
      this.classificationStats.set(route, {
        count: 0,
        totalConfidence: 0,
        routes: []
      });
    }

    const stats = this.classificationStats.get(route)!;
    stats.count++;
    stats.totalConfidence += data.confidence;
    stats.routes.push(data);

    // Keep only last 100 classifications
    if (stats.routes.length > 100) {
      stats.routes.shift();
    }
  }

  /**
   * Add request to history
   */
  public addToRequestHistory(request: any): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  public publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) return;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'virtual-router',
        operationId: type,
        timestamp: Date.now(),
        type: 'debug',
        position: 'middle',
        data: {
          ...data,
          routerId: 'virtual-router',
          source: 'virtual-router'
        }
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      routerId: this.getInfo().id,
      name: this.getInfo().name,
      version: this.getInfo().version,
      isInitialized: this.getStatus() !== 'stopped',
      isRunning: this.isModuleRunning(),
      status: this.getStatus(),
      routeTargets: Object.keys(this.routeTargets),
      pipelineConfigs: Object.keys(this.pipelineConfigs),
      protocolManager: this.protocolManager.getStatus(),
      loadBalancer: this.loadBalancer.getStatus(),
      isEnhanced: true
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      performanceStats: this.getPerformanceStats(),
      routingMetrics: this.getRoutingMetrics(),
      classificationStats: this.getClassificationStats(),
      requestHistory: [...this.requestHistory.slice(-10)] // Last 10 requests
    };
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): any {
    return {
      routerId: 'virtual-router',
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      routeTargetsCount: Object.keys(this.routeTargets).length,
      pipelineConfigsCount: Object.keys(this.pipelineConfigs).length,
      requestHistorySize: this.requestHistory.length,
      classificationEnabled: !!this.configRequestClassifier
    };
  }

  /**
   * Get performance statistics
   */
  private getPerformanceStats(): any {
    const stats: any = {};

    for (const [operation, metric] of this.routingMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        stats[operation] = {
          count: values.length,
          avgTime: Math.round(values.reduce((sum: any, v: any) => sum + (v.totalTime || v.selectionTime || 0), 0) / values.length),
          minTime: Math.min(...values.map((v: any) => v.totalTime || v.selectionTime || 0)),
          maxTime: Math.max(...values.map((v: any) => v.totalTime || v.selectionTime || 0)),
          lastUpdated: metric.lastUpdated
        };
      }
    }

    return stats;
  }

  /**
   * Get routing metrics
   */
  public getRoutingMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.routingMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Get classification statistics
   */
  private getClassificationStats(): any {
    const stats: any = {};

    for (const [route, data] of this.classificationStats.entries()) {
      stats[route] = {
        count: data.count,
        avgConfidence: Math.round(data.totalConfidence / data.count),
        recentClassifications: data.routes.slice(-5) // Last 5 classifications
      };
    }

    return stats;
  }
}

// 协议管理器
class ProtocolManager {
  private inputProtocol: string = 'openai';
  private outputProtocol: string = 'openai';

  async initialize(config: { inputProtocol: string; outputProtocol: string }): Promise<void> {
    this.inputProtocol = config.inputProtocol;
    this.outputProtocol = config.outputProtocol;
  }

  async convertRequest(request: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return request;
    }

    // TODO: 实现协议转换逻辑
    console.log(`🔄 Converting request from ${fromProtocol} to ${toProtocol}`);
    return request;
  }

  async convertResponse(response: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return response;
    }

    // TODO: 实现协议转换逻辑
    console.log(`🔄 Converting response from ${fromProtocol} to ${toProtocol}`);
    return response;
  }

  getStatus(): any {
    return {
      inputProtocol: this.inputProtocol,
      outputProtocol: this.outputProtocol
    };
  }
}

// 负载均衡器 - 支持多层轮询：目标池轮询 + Key轮询
class LoadBalancer {
  private routeTargets: RouteTargetPool = {};
  private poolIndex: Map<string, number> = new Map(); // 目标池轮询索引
  private keyIndex: Map<string, number> = new Map(); // Key轮询索引

  async initialize(routeTargets: RouteTargetPool): Promise<void> {
    this.routeTargets = routeTargets;
    this.buildTargetPools();
  }

  /**
   * 构建目标池 - 将具体的目标按 provider.model 分组
   */
  private buildTargetPools(): void {
    for (const routeName in this.routeTargets) {
      const targets = this.routeTargets[routeName];
      const poolKey = `${routeName}`;

      // 初始化目标池索引
      if (!this.poolIndex.has(poolKey)) {
        this.poolIndex.set(poolKey, 0);
      }

      // 为每个 provider.model 组合初始化key索引
      const providerModelGroups = this.groupByProviderModel(targets);
      for (const providerModel in providerModelGroups) {
        const keyPoolKey = `${routeName}.${providerModel}`;
        if (!this.keyIndex.has(keyPoolKey)) {
          this.keyIndex.set(keyPoolKey, 0);
        }
      }
    }
  }

  /**
   * 按 provider.model 分组目标
   */
  private groupByProviderModel(targets: RouteTarget[]): Record<string, RouteTarget[]> {
    const groups: Record<string, RouteTarget[]> = {};

    targets.forEach(target => {
      const key = `${target.providerId}.${target.modelId}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(target);
    });

    return groups;
  }

  /**
   * 选择目标 - 两层轮询：目标池轮询 + Key轮询
   */
  async selectTarget(targets: RouteTarget[], routeName: string = 'default', request?: any): Promise<RouteTarget | null> {
    if (targets.length === 0) {
      return null;
    }

    if (targets.length === 1) {
      return targets[0];
    }

    // Prefer direct model match when the request specifies a model
    if (request?.model) {
      const normalizedModel = String(request.model).toLowerCase();
      const directMatch = targets.find(target => target.modelId?.toLowerCase?.() === normalizedModel);
      if (directMatch) {
        this.advanceIndexesForMatch(routeName, directMatch);
        return directMatch;
      }
    }

    // 第一步：按 provider.model 分组
    const providerModelGroups = this.groupByProviderModel(targets);
    const providerModels = Object.keys(providerModelGroups);

    console.log(`🎯 Route "${routeName}" has ${providerModels.length} provider.model groups:`);
    providerModels.forEach(pm => {
      console.log(`   - ${pm}: ${providerModelGroups[pm].length} keys`);
    });

    // 第二步：目标池轮询 - 选择 provider.model 组合
    const poolKey = `${routeName}`;
    const currentPoolIndex = this.poolIndex.get(poolKey) || 0;
    const selectedProviderModel = providerModels[currentPoolIndex];

    console.log(`🔄 Pool轮询 for "${routeName}": selected ${selectedProviderModel} (index ${currentPoolIndex})`);

    // 第三步：Key轮询 - 在选中的 provider.model 组合中选择具体的key
    const keyPoolKey = `${routeName}.${selectedProviderModel}`;
    const availableKeys = providerModelGroups[selectedProviderModel];

    const currentKeyIndex = this.keyIndex.get(keyPoolKey) || 0;
    const selectedTarget = availableKeys[currentKeyIndex];

    console.log(`🔑 Key轮询 for "${selectedProviderModel}": selected key ${currentKeyIndex + 1}/${availableKeys.length} (${selectedTarget.keyId})`);

    // 更新索引 - 独立更新两个索引
    const nextKeyIndex = (currentKeyIndex + 1) % availableKeys.length;
    this.keyIndex.set(keyPoolKey, nextKeyIndex);

    // 每次请求都前进到下一个provider.model，实现真正的轮询
    const nextPoolIndex = (currentPoolIndex + 1) % providerModels.length;
    this.poolIndex.set(poolKey, nextPoolIndex);
    console.log(`🎯 Pool轮询前进: ${currentPoolIndex} → ${nextPoolIndex}`);

    console.log(`✅ Final target: ${selectedTarget.providerId}.${selectedTarget.modelId}.${selectedTarget.keyId}`);

    return selectedTarget;
  }

  private advanceIndexesForMatch(routeName: string, target: RouteTarget): void {
    const providerModelGroups = this.groupByProviderModel(this.routeTargets[routeName] || []);
    const providerModels = Object.keys(providerModelGroups);
    const selectedKey = `${target.providerId}.${target.modelId}`;

    if (providerModels.length > 0) {
      const poolIndex = providerModels.indexOf(selectedKey);
      if (poolIndex >= 0) {
        const nextPoolIndex = (poolIndex + 1) % providerModels.length;
        this.poolIndex.set(`${routeName}`, nextPoolIndex);
      }
    }

    const keyPoolKey = `${routeName}.${selectedKey}`;
    const availableKeys = providerModelGroups[selectedKey] || [];
    if (availableKeys.length > 0) {
      const nextKeyIndex = (availableKeys.findIndex(k => k.keyId === target.keyId) + 1) % availableKeys.length;
      this.keyIndex.set(keyPoolKey, nextKeyIndex);
    }
  }

  /**
   * 获取详细的负载均衡状态
   */
  getStatus(): any {
    const poolStatus: Record<string, any> = {};
    const keyStatus: Record<string, any> = {};

    // 构建池状态
    this.poolIndex.forEach((index, key) => {
      const [routeName] = key.split('.');
      const targets = this.routeTargets[routeName] || [];
      const providerModelGroups = this.groupByProviderModel(targets);
      const providerModels = Object.keys(providerModelGroups);

      poolStatus[key] = {
        currentIndex: index,
        totalGroups: providerModels.length,
        currentGroup: providerModels[index] || 'unknown'
      };
    });

    // 构建key状态
    this.keyIndex.forEach((index, key) => {
      const [routeName, providerModel] = key.split('.');
      const targets = this.routeTargets[routeName] || [];
      const providerModelGroups = this.groupByProviderModel(targets);
      const availableKeys = providerModelGroups[providerModel] || [];

      keyStatus[key] = {
        currentIndex: index,
        totalKeys: availableKeys.length,
        currentKey: availableKeys[index]?.keyId || 'unknown'
      };
    });

    return {
      strategy: 'multi-layer-round-robin',
      description: '目标池轮询 + Key轮询',
      poolIndex: poolStatus,
      keyIndex: keyStatus
    };
  }

  /**
   * 重置索引（用于测试或重置）
   */
  resetIndex(routeName?: string): void {
    if (routeName) {
      // 重置指定路由的所有索引
      const poolKey = `${routeName}`;
      this.poolIndex.delete(poolKey);

      // 删除该路由下的所有key索引
      const keysToDelete: string[] = [];
      this.keyIndex.forEach((_, key) => {
        if (key.startsWith(`${routeName}.`)) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(key => this.keyIndex.delete(key));

      // 重新初始化
      if (this.routeTargets[routeName]) {
        this.buildTargetPools();
      }
    } else {
      // 重置所有索引
      this.poolIndex.clear();
      this.keyIndex.clear();
      this.buildTargetPools();
    }
  }

  /**
   * 获取统计信息
   */
  getStatistics(routeName?: string): any {
    const stats: any = {};

    const targetRoutes = routeName ? [routeName] : Object.keys(this.routeTargets);

    targetRoutes.forEach(route => {
      const targets = this.routeTargets[route] || [];
      const providerModelGroups = this.groupByProviderModel(targets);

      stats[route] = {
        totalTargets: targets.length,
        providerModelGroups: Object.keys(providerModelGroups).length,
        groups: Object.fromEntries(
          Object.entries(providerModelGroups).map(([pm, keys]) => [
            pm,
            { keyCount: keys.length, keyIds: keys.map(k => k.keyId) }
          ])
        )
      };
    });

    return stats;
  }

  }
