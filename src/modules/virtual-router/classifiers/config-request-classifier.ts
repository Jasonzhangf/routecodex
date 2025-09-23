/**
 * Configuration-Driven Request Classifier
 * 基于配置的请求分类器 - 整合所有组件
 */

import { ProtocolTokenCalculator } from './protocol-token-calculator.js';
import { ConfigToolDetector } from './config-tool-detector.js';
import { ConfigRoutingDecision } from './config-routing-decision.js';
import { ConfigModelTierClassifier } from './config-model-tier-classifier.js';

export interface ConfigClassificationInput {
  request: any;
  endpoint: string;
  protocol?: string;
  userPreferences?: {
    preferredTier?: 'basic' | 'advanced';
    costSensitive?: boolean;
    performanceCritical?: boolean;
    qualityCritical?: boolean;
  };
}

export interface ConfigClassificationResult {
  success: boolean;
  route: string;
  modelTier: 'basic' | 'advanced';
  confidence: number;
  reasoning: string;
  analysis: {
    protocol: string;
    tokenAnalysis: any;
    toolAnalysis: any;
    modelTierAnalysis: any;
    routingDecision: any;
  };
  factors: {
    tokenBased: boolean;
    toolBased: boolean;
    modelBased: boolean;
    complexityBased: boolean;
  };
  recommendations: {
    suggestedRoute: string;
    suggestedModelTier: 'basic' | 'advanced';
    alternativeRoutes: Array<{
      route: string;
      confidence: number;
      reasoning: string;
    }>;
    warnings: string[];
  };
  performance: {
    classificationTime: number;
    steps: Array<{
      step: string;
      duration: number;
      success: boolean;
    }>;
  };
  configBased: boolean;
}

export interface ConfigClassifierConfig {
  protocolMapping: {
    [key: string]: {
      endpoints: string[];
      messageField: string;
      modelField: string;
      toolsField: string;
      maxTokensField: string;
    };
  };
  protocolHandlers: {
    [key: string]: {
      tokenCalculator: any;
      toolDetector: any;
    };
  };
  modelTiers: {
    basic: any;
    advanced: any;
  };
  routingDecisions: any;
  confidenceThreshold: number;
}

export class ConfigRequestClassifier {
  private config: ConfigClassifierConfig;
  private tokenCalculators: Map<string, ProtocolTokenCalculator> = new Map();
  private toolDetectors: Map<string, ConfigToolDetector> = new Map();
  private routingDecision!: ConfigRoutingDecision;
  private modelTierClassifier!: ConfigModelTierClassifier;

  constructor(config: ConfigClassifierConfig) {
    this.config = config;
    this.initializeComponents();
  }

  /**
   * 初始化组件
   */
  private initializeComponents(): void {
    // 初始化Token计算器
    for (const [protocol, handler] of Object.entries(this.config.protocolHandlers)) {
      try {
        const tokenCalculator = this.createTokenCalculator(protocol, handler.tokenCalculator);
        this.tokenCalculators.set(protocol, tokenCalculator);
      } catch (error) {
        console.warn(`Failed to initialize token calculator for protocol ${protocol}:`, error);
      }

      try {
        const toolDetector = ConfigToolDetector.fromModuleConfig(handler);
        this.toolDetectors.set(protocol, toolDetector);
      } catch (error) {
        console.warn(`Failed to initialize tool detector for protocol ${protocol}:`, error);
      }
    }

    // 初始化路由决策器
    this.routingDecision = ConfigRoutingDecision.fromModuleConfig(this.config);

    // 初始化模型层级分类器
    this.modelTierClassifier = ConfigModelTierClassifier.fromModuleConfig(this.config);
  }

  /**
   * 创建协议专用的Token计算器
   */
  private createTokenCalculator(protocol: string, config: any): ProtocolTokenCalculator {
    if (protocol === 'openai') {
      return ProtocolTokenCalculator.createOpenAICalculator();
    } else if (protocol === 'anthropic') {
      return ProtocolTokenCalculator.createAnthropicCalculator();
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  /**
   * 分类请求
   */
  async classify(input: ConfigClassificationInput): Promise<ConfigClassificationResult> {
    const startTime = Date.now();
    const steps: Array<{ step: string; duration: number; success: boolean }> = [];

    try {
      // 1. 协议检测
      const protocolStep = await this.detectProtocol(input.endpoint);
      steps.push({ step: 'protocol_detection', duration: Date.now() - startTime, success: protocolStep.success });

      if (!protocolStep.success) {
        return this.createErrorResult('Protocol detection failed', steps);
      }

      const protocol = protocolStep.protocol;

      // 2. Token分析
      const tokenStep = await this.analyzeTokens(input.request, input.endpoint, protocol || 'openai');
      steps.push({ step: 'token_analysis', duration: Date.now() - startTime, success: tokenStep.success });

      if (!tokenStep.success) {
        return this.createErrorResult('Token analysis failed', steps);
      }

      // 3. 工具分析
      const toolStep = await this.analyzeTools(input.request, protocol || 'openai');
      steps.push({ step: 'tool_analysis', duration: Date.now() - startTime, success: toolStep.success });

      // 4. 模型层级分析
      const modelTierStep = await this.analyzeModelTier(input.request, tokenStep.result, input.userPreferences);
      steps.push({ step: 'model_tier_analysis', duration: Date.now() - startTime, success: modelTierStep.success });

      // 5. 路由决策
      const routingStep = await this.makeRoutingDecision(
        tokenStep.result,
        toolStep.result,
        modelTierStep.result,
        protocol || 'openai',
        input.endpoint,
        input.request
      );
      steps.push({ step: 'routing_decision', duration: Date.now() - startTime, success: routingStep.success });

      if (!routingStep.success) {
        return this.createErrorResult('Routing decision failed', steps);
      }

      // 6. 整合结果
      const result = this.integrateResults(
        protocol || 'openai',
        tokenStep.result,
        toolStep.result,
        modelTierStep.result,
        routingStep.result,
        steps,
        Date.now() - startTime
      );

      return result;

    } catch (error) {
      console.error('Classification failed:', error);
      return this.createErrorResult(`Classification error: ${error}`, steps);
    }
  }

  /**
   * 检测协议
   */
  private async detectProtocol(endpoint: string): Promise<{ success: boolean; protocol?: string }> {
    try {
      for (const [protocol, mapping] of Object.entries(this.config.protocolMapping)) {
        for (const endpointPattern of mapping.endpoints) {
          if (endpoint.includes(endpointPattern)) {
            return { success: true, protocol };
          }
        }
      }
      return { success: false };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * 分析Token
   */
  private async analyzeTokens(request: any, endpoint: string, protocol: string): Promise<{ success: boolean; result?: any }> {
    try {
      const tokenCalculator = this.tokenCalculators.get(protocol);
      if (!tokenCalculator) {
        return { success: false };
      }

      const result = tokenCalculator.calculate(request, endpoint);
      return { success: true, result };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * 分析工具
   */
  private async analyzeTools(request: any, protocol: string): Promise<{ success: boolean; result?: any }> {
    try {
      const toolDetector = this.toolDetectors.get(protocol);
      if (!toolDetector) {
        return { success: false, result: { hasTools: false, toolTypes: [], complexity: { medium: 0 } } };
      }

      const protocolConfig = this.config.protocolMapping[protocol];
      const messages = request[protocolConfig.messageField];
      const tools = request[protocolConfig.toolsField];

      const result = toolDetector.detect(tools, messages);
      return { success: true, result };
    } catch (error) {
      return { success: false, result: { hasTools: false, toolTypes: [], complexity: { medium: 0 } } };
    }
  }

  /**
   * 分析模型层级
   */
  private async analyzeModelTier(
    request: any,
    tokenAnalysis: any,
    userPreferences?: any
  ): Promise<{ success: boolean; result?: any }> {
    try {
      const protocol = this.detectProtocolSync(request.endpoint || '');
      const protocolConfig = this.config.protocolMapping[protocol];
      if (!protocolConfig) {
        return { success: false };
      }

      const model = request[protocolConfig.modelField];

      const result = this.modelTierClassifier.classify({
        model,
        requestedMaxTokens: request[protocolConfig.maxTokensField],
        context: {
          protocol,
          endpoint: request.endpoint || '',
          estimatedTokens: tokenAnalysis?.totalTokens || 0,
          userPreferences
        }
      });

      return { success: true, result };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * 做出路由决策
   */
  private async makeRoutingDecision(
    tokenAnalysis: any,
    toolAnalysis: any,
    modelTierAnalysis: any,
    protocol: string,
    endpoint: string,
    request: any
  ): Promise<{ success: boolean; result?: any }> {
    try {
      const protocolConfig = this.config.protocolMapping[protocol];
      if (!protocolConfig) {
        return { success: false };
      }

      const model = this.extractModelFromRequest(request, protocolConfig);

      const input = {
        protocol,
        endpoint,
        model,
        tokenCount: tokenAnalysis?.totalTokens || 0,
        toolTypes: toolAnalysis?.toolTypes || [],
        hasTools: toolAnalysis?.hasTools || false,
        complexity: toolAnalysis?.complexity?.medium || 0,
        requestedMaxTokens: this.extractMaxTokensFromRequest(request, protocolConfig)
      };

      const result = this.routingDecision.makeDecision(input);
      return { success: true, result };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * 整合结果
   */
  private integrateResults(
    protocol: string,
    tokenAnalysis: any,
    toolAnalysis: any,
    modelTierAnalysis: any,
    routingDecision: any,
    steps: any[],
    totalTime: number
  ): ConfigClassificationResult {
    // 安全地访问置信度和属性
    const routingConfidence = routingDecision?.confidence || 0;
    const modelTierConfidence = modelTierAnalysis?.confidence || 0;
    // 使用平均置信度而不是最小值，避免单个低置信度影响整体结果
    const finalConfidence = (routingConfidence + modelTierConfidence) / 2;

    const warnings: string[] = [];
    if (finalConfidence < this.config.confidenceThreshold / 100) {
      warnings.push('分类置信度低于阈值');
    }

    if (modelTierAnalysis?.recommendations?.warnings) {
      warnings.push(...modelTierAnalysis.recommendations.warnings);
    }

    return {
      success: true,
      route: routingDecision?.route || 'default',
      modelTier: routingDecision?.modelTier || 'basic',
      confidence: finalConfidence,
      reasoning: `${routingDecision?.reasoning || ''} ${modelTierAnalysis?.reasoning || ''}`.trim(),
      analysis: {
        protocol,
        tokenAnalysis,
        toolAnalysis,
        modelTierAnalysis,
        routingDecision
      },
      factors: routingDecision?.factors || {
        tokenBased: false,
        toolBased: false,
        modelBased: false,
        complexityBased: false
      },
      recommendations: {
        suggestedRoute: routingDecision?.route || 'default',
        suggestedModelTier: routingDecision?.modelTier || 'basic',
        alternativeRoutes: routingDecision?.alternativeRoutes || [],
        warnings
      },
      performance: {
        classificationTime: totalTime,
        steps
      },
      configBased: true
    };
  }

  /**
   * 创建错误结果
   */
  private createErrorResult(error: string, steps: any[]): ConfigClassificationResult {
    return {
      success: false,
      route: 'default',
      modelTier: 'basic',
      confidence: 0,
      reasoning: error,
      analysis: {
        protocol: 'unknown',
        tokenAnalysis: null,
        toolAnalysis: null,
        modelTierAnalysis: null,
        routingDecision: null
      },
      factors: {
        tokenBased: false,
        toolBased: false,
        modelBased: false,
        complexityBased: false
      },
      recommendations: {
        suggestedRoute: 'default',
        suggestedModelTier: 'basic',
        alternativeRoutes: [],
        warnings: [error]
      },
      performance: {
        classificationTime: 0,
        steps
      },
      configBased: true
    };
  }

  /**
   * 同步协议检测
   */
  private detectProtocolSync(endpoint: string): string {
    for (const [protocol, mapping] of Object.entries(this.config.protocolMapping)) {
      for (const endpointPattern of mapping.endpoints) {
        if (endpoint.includes(endpointPattern)) {
          return protocol;
        }
      }
    }
    return 'unknown';
  }

  /**
   * 从请求中提取模型
   */
  private extractModelFromRequest(request: any, protocolConfig: any): string {
    // 从请求中提取模型字段
    return request[protocolConfig.modelField] || 'unknown-model';
  }

  /**
   * 从请求中提取最大Token数
   */
  private extractMaxTokensFromRequest(request: any, protocolConfig: any): number | undefined {
    // 从请求中提取最大Token字段
    return request[protocolConfig.maxTokensField];
  }

  /**
   * 获取分类器状态
   */
  getStatus(): {
    ready: boolean;
    protocols: string[];
    tokenCalculators: number;
    toolDetectors: number;
    configValidation: any;
  } {
    const configValidation = this.routingDecision.validateConfig();

    return {
      ready: this.tokenCalculators.size > 0 && this.toolDetectors.size > 0,
      protocols: Array.from(this.tokenCalculators.keys()),
      tokenCalculators: this.tokenCalculators.size,
      toolDetectors: this.toolDetectors.size,
      configValidation
    };
  }

  /**
   * 从模块配置创建请求分类器
   */
  static fromModuleConfig(classificationConfig: any): ConfigRequestClassifier {
    const config: ConfigClassifierConfig = {
      protocolMapping: classificationConfig.protocolMapping,
      protocolHandlers: classificationConfig.protocolHandlers,
      modelTiers: classificationConfig.modelTiers,
      routingDecisions: classificationConfig.routingDecisions,
      confidenceThreshold: classificationConfig.confidenceThreshold || 60
    };

    return new ConfigRequestClassifier(config);
  }
}