/**
 * Configuration-Driven Request Classifier
 * 基于配置的请求分类器 - 整合所有组件
 */

import { ProtocolTokenCalculator } from './protocol-token-calculator.js';
import { ConfigToolDetector } from './config-tool-detector.js';
import { ConfigRoutingDecision, type RoutingDecisionResult } from './config-routing-decision.js';
import { ConfigModelTierClassifier, type ModelTierClassificationResult, type EnhancedModelTierConfig } from './config-model-tier-classifier.js';
import type { ProtocolTokenCalculationResult } from './protocol-token-calculator.js';
import type { ConfigToolDetectionResult } from './config-tool-detector.js';
import type { UnknownObject } from '../../../types/common-types.js';

export interface ConfigClassificationInput {
  request: UnknownObject;
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
    tokenAnalysis: ProtocolTokenCalculationResult;
    toolAnalysis: ConfigToolDetectionResult;
    modelTierAnalysis: ModelTierClassificationResult;
    routingDecision: RoutingDecisionResult;
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
      tokenCalculator: unknown;
      toolDetector: unknown;
    };
  };
  modelTiers: {
    basic: EnhancedModelTierConfig;
    advanced: EnhancedModelTierConfig;
  };
  routingDecisions: import('./config-routing-decision.js').RoutingDecisionConfig;
  confidenceThreshold: number;
  // 额外配置：基于文本/Token的简单决策树所需参数
  thinkingKeywords?: string[];
  longContextThresholdTokens?: number;
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
        // 检查handler是否包含toolDetector配置
        if (handler.toolDetector) {
          const toolDetector = ConfigToolDetector.fromModuleConfig(handler);
          this.toolDetectors.set(protocol, toolDetector);
        }
      } catch (error) {
        console.warn(`Failed to initialize tool detector for protocol ${protocol}:`, error);
      }
    }

    // 初始化路由决策器
    this.routingDecision = ConfigRoutingDecision.fromModuleConfig({
      modelTiers: this.config.modelTiers,
      routingDecisions: this.config.routingDecisions
    });

    // 初始化模型层级分类器
    this.modelTierClassifier = ConfigModelTierClassifier.fromModuleConfig({
      modelTiers: this.config.modelTiers
    });
  }

  /**
   * 创建协议专用的Token计算器
   */
  private createTokenCalculator(protocol: string, _config: unknown): ProtocolTokenCalculator {
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
      const modelTierStep = await this.analyzeModelTier(input.request, tokenStep.result!, input.userPreferences);
      steps.push({ step: 'model_tier_analysis', duration: Date.now() - startTime, success: modelTierStep.success });

      // 5. 构建特征 + 简单决策树路由
      const features = this.buildRequestFeatures(
        input.request,
        input.endpoint,
        protocol || 'openai',
        tokenStep.result!,
        toolStep.result!
      );
      const routingDecision = this.decideRoute(features, modelTierStep.result!);
      steps.push({ step: 'routing_decision', duration: Date.now() - startTime, success: true });

      // 6. 整合结果（confidence 仅用于诊断，不参与路由选择）
      const result = this.integrateResults(
        protocol || 'openai',
        tokenStep.result!,
        toolStep.result!,
        modelTierStep.result!,
        routingDecision,
        steps,
        Date.now() - startTime
      );

      return result;

    } catch (error) {
      console.error('Classification failed:', error);
      return this.createErrorResult(`Classification error: ${error instanceof Error ? error.message : String(error)}`, steps);
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
   * 检测当前请求是否包含图像内容（用于vision路由判定）
   * - OpenAI: messages[].content[] 中 type 包含 image/image_url
   * - Anthropic: messages[].content[] 中 type 包含 image
   */
  private hasImageContentForProtocol(request: UnknownObject, protocol: string): boolean {
    try {
      const mapping = this.config.protocolMapping[protocol];
      if (!mapping) return false;
      const rawMessages = (request as Record<string, unknown>)[mapping.messageField] as unknown;
      if (!Array.isArray(rawMessages)) return false;
      for (const m of rawMessages as any[]) {
        if (!m || typeof m !== 'object') continue;
        const content = (m as any).content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            const t = String((part as any).type || '').toLowerCase();
            if (t.includes('image')) {
              return true;
            }
            // OpenAI style: { type: 'image_url', image_url: { url: string } }
            const url = (part as any).image_url && typeof (part as any).image_url.url === 'string'
              ? (part as any).image_url.url
              : undefined;
            if (url && url.trim()) return true;
          }
        }
      }
    } catch {
      // 非致命，默认为无图像
    }
    return false;
  }

  /**
   * 检测thinking意图：基于用户提示词中的中英文关键字匹配
   */
  private detectThinkingIntent(request: UnknownObject, endpoint: string): boolean {
    const keywords = this.config.thinkingKeywords || [];
    if (!keywords.length) return false;

    let primaryText = '';
    let allText = '';

    try {
      // 基于protocolMapping抽取messages字段
      const protocol = this.detectProtocolSync(endpoint);
      const mapping = this.config.protocolMapping[protocol];
      if (!mapping) return false;
      const rawMessages = (request as Record<string, unknown>)[mapping.messageField] as unknown;
      const messages = Array.isArray(rawMessages) ? rawMessages as any[] : [];

      const userTexts: string[] = [];
      for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        const role = String((m as any).role || '').toLowerCase();
        if (role !== 'user') continue;
        const c = (m as any).content;
        if (typeof c === 'string') {
          userTexts.push(c);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
              userTexts.push((part as any).text);
            }
          }
        }
      }
      if (userTexts.length) {
        primaryText = userTexts[userTexts.length - 1];
        allText = userTexts.join('\n');
      }
    } catch {
      // ignore extraction errors
    }

    const source = (primaryText + '\n' + allText).toLowerCase();
    if (!source.trim()) return false;

    for (const kw of keywords) {
      if (!kw) continue;
      const needle = String(kw).toLowerCase();
      if (!needle.trim()) continue;
      if (source.includes(needle)) return true;
    }
    return false;
  }

  /**
   * 分析Token
  */
  private async analyzeTokens(request: UnknownObject, endpoint: string, protocol: string): Promise<{ success: boolean; result?: ProtocolTokenCalculationResult }> {
    try {
      const tokenCalculator = this.tokenCalculators.get(protocol);
      if (!tokenCalculator) {
        return { success: false };
      }

      // 优先使用异步的精确Token计算（内部使用tiktoken，严格模式），不可用时标记失败
      const anyCalc = tokenCalculator as any;
      if (typeof anyCalc.calculateAsync !== 'function') {
        return { success: false };
      }
      const result: ProtocolTokenCalculationResult = await anyCalc.calculateAsync(request, endpoint);
      return { success: true, result };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * 分析工具
   */
  private async analyzeTools(request: UnknownObject, protocol: string): Promise<{ success: boolean; result?: ConfigToolDetectionResult }> {
    try {
      const toolDetector = this.toolDetectors.get(protocol);
      if (!toolDetector) {
        return { success: false, result: { hasTools: false, toolTypes: [], toolCount: 0, toolCategories: { webSearch: false, codeExecution: false, fileSearch: false, dataAnalysis: false, general: false }, complexity: { low: 0, medium: 0, high: 0 }, recommendations: { suggestedRoute: 'default', reasoning: 'no-detector', confidence: 0 }, configBased: true } };
      }

      const protocolConfig = this.config.protocolMapping[protocol];
      const rawMessages = (request as Record<string, unknown>)[protocolConfig.messageField] as unknown;
      const rawTools = (request as Record<string, unknown>)[protocolConfig.toolsField] as unknown;
      const messages = Array.isArray(rawMessages) ? (rawMessages as any[]) : undefined;
      const tools = Array.isArray(rawTools) ? (rawTools as any[]) : undefined;

      const result = toolDetector.detect(tools as any, messages as any);
      return { success: true, result };
    } catch (error) {
      return { success: false, result: { hasTools: false, toolTypes: [], toolCount: 0, toolCategories: { webSearch: false, codeExecution: false, fileSearch: false, dataAnalysis: false, general: false }, complexity: { low: 0, medium: 0, high: 0 }, recommendations: { suggestedRoute: 'default', reasoning: 'error', confidence: 0 }, configBased: true } };
    }
  }

  /**
   * 分析模型层级
   */
  private async analyzeModelTier(
    request: UnknownObject,
    tokenAnalysis: ProtocolTokenCalculationResult,
    userPreferences?: {
      preferredTier?: 'basic' | 'advanced';
      costSensitive?: boolean;
      performanceCritical?: boolean;
      qualityCritical?: boolean;
    }
  ): Promise<{ success: boolean; result?: ModelTierClassificationResult }> {
    try {
      const endpointStr = typeof (request as Record<string, unknown>)['endpoint'] === 'string'
        ? (request as Record<string, unknown>)['endpoint'] as string
        : '';
      const protocol = this.detectProtocolSync(endpointStr);
      const protocolConfig = this.config.protocolMapping[protocol];
      if (!protocolConfig) {
        return { success: false };
      }

      const model = String((request as Record<string, unknown>)[protocolConfig.modelField] || 'unknown');

      const maxValRaw = (request as Record<string, unknown>)[protocolConfig.maxTokensField] as unknown;
      const requestedMax = typeof maxValRaw === 'number' ? maxValRaw : undefined;
      const result = this.modelTierClassifier.classify({
        model,
        requestedMaxTokens: requestedMax,
        context: {
          protocol,
          endpoint: endpointStr,
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
   * 构建用于简单决策树的请求特征
   */
  private buildRequestFeatures(
    request: UnknownObject,
    endpoint: string,
    protocol: string,
    tokenAnalysis: ProtocolTokenCalculationResult,
    toolAnalysis: ConfigToolDetectionResult
  ): {
    protocol: string;
    endpoint: string;
    model: string;
    totalTokens: number;
    hasTools: boolean;
    toolTypes: string[];
    hasWebSearchTools: boolean;
    hasEditTools: boolean;
    hasDataAnalysisTools: boolean;
    hasImageContent: boolean;
    thinkingIntent: boolean;
  } {
    const mapping = this.config.protocolMapping[protocol] || Object.values(this.config.protocolMapping)[0];
    const model = mapping ? this.extractModelFromRequest(request, mapping as any) : 'unknown-model';
    const toolTypes = toolAnalysis?.toolTypes || [];
    const hasTools = toolAnalysis?.hasTools || false;
    const hasWebSearchTools = toolTypes.includes('webSearch');
    const hasEditTools = toolTypes.includes('codeExecution') || toolTypes.includes('fileSearch');
    const hasDataAnalysisTools = toolTypes.includes('dataAnalysis');
    const hasImageContent = this.hasImageContentForProtocol(request, protocol);
    const thinkingIntent = this.detectThinkingIntent(request, endpoint);

    return {
      protocol,
      endpoint,
      model,
      totalTokens: tokenAnalysis?.totalTokens || 0,
      hasTools,
      toolTypes,
      hasWebSearchTools,
      hasEditTools,
      hasDataAnalysisTools,
      hasImageContent,
      thinkingIntent
    };
  }

  /**
   * 简单决策树：根据RequestFeatures和配置做出路由决策（无打分，只有顺序规则）
   */
  private decideRoute(
    f: {
      protocol: string;
      endpoint: string;
      model: string;
      totalTokens: number;
      hasTools: boolean;
      toolTypes: string[];
      hasWebSearchTools: boolean;
      hasEditTools: boolean;
      hasDataAnalysisTools: boolean;
      hasImageContent: boolean;
      thinkingIntent: boolean;
    },
    modelTierAnalysis: ModelTierClassificationResult
  ): RoutingDecisionResult {
    const routingCfg = this.config.routingDecisions || {};
    const hasRoute = (name: string) => Object.prototype.hasOwnProperty.call(routingCfg, name);
    const longThreshold = typeof this.config.longContextThresholdTokens === 'number'
      ? this.config.longContextThresholdTokens
      : 100000;

    const alternatives: Array<{ route: string; confidence: number; reasoning: string }> = [];

    // 1) Vision
    if (hasRoute('vision')) {
      if (f.hasImageContent) {
        return {
          route: 'vision',
          modelTier: modelTierAnalysis?.tier || 'advanced',
          confidence: 1,
          reasoning: 'has_image_content',
          factors: { tokenBased: false, toolBased: false, modelBased: true, complexityBased: false },
          alternativeRoutes: alternatives,
          configBased: true
        };
      }
    }

    // 2) Long context
    if (hasRoute('longContext') && f.totalTokens >= longThreshold) {
      return {
        route: 'longContext',
        modelTier: modelTierAnalysis?.tier || 'advanced',
        confidence: 1,
        reasoning: `token_count>=${longThreshold}`,
        factors: { tokenBased: true, toolBased: false, modelBased: true, complexityBased: false },
        alternativeRoutes: alternatives,
        configBased: true
      };
    }

    // 3) Thinking（文本意图）
    if (hasRoute('thinking') && f.thinkingIntent) {
      return {
        route: 'thinking',
        modelTier: modelTierAnalysis?.tier || 'advanced',
        confidence: 1,
        reasoning: 'thinking_keywords_matched',
        factors: { tokenBased: false, toolBased: false, modelBased: true, complexityBased: false },
        alternativeRoutes: alternatives,
        configBased: true
      };
    }

    // 4) Coding（编辑/执行类工具）
    if (hasRoute('coding') && f.hasEditTools) {
      return {
        route: 'coding',
        modelTier: modelTierAnalysis?.tier || 'advanced',
        confidence: 1,
        reasoning: 'edit_tools_present',
        factors: { tokenBased: false, toolBased: true, modelBased: true, complexityBased: false },
        alternativeRoutes: alternatives,
        configBased: true
      };
    }

    // 5) WebSearch
    if (hasRoute('webSearch') && f.hasWebSearchTools) {
      return {
        route: 'webSearch',
        modelTier: modelTierAnalysis?.tier || 'advanced',
        confidence: 1,
        reasoning: 'web_search_tools_present',
        factors: { tokenBased: false, toolBased: true, modelBased: true, complexityBased: false },
        alternativeRoutes: alternatives,
        configBased: true
      };
    }

    // 6) Tools（有工具但未命中其它路由）
    if (hasRoute('tools') && f.hasTools) {
      return {
        route: 'tools',
        modelTier: modelTierAnalysis?.tier || 'advanced',
        confidence: 1,
        reasoning: 'tools_present',
        factors: { tokenBased: false, toolBased: true, modelBased: true, complexityBased: false },
        alternativeRoutes: alternatives,
        configBased: true
      };
    }

    // 7) Default 兜底
    const fallbackRoute = hasRoute('default') ? 'default' : Object.keys(routingCfg)[0] || 'default';
    return {
      route: fallbackRoute,
      modelTier: modelTierAnalysis?.tier || 'basic',
      confidence: 1,
      reasoning: 'no_rule_matched',
      factors: { tokenBased: false, toolBased: false, modelBased: true, complexityBased: false },
      alternativeRoutes: alternatives,
      configBased: true
    };
  }

  /**
   * 整合结果
   */
  private integrateResults(
    protocol: string,
    tokenAnalysis: ProtocolTokenCalculationResult,
    toolAnalysis: ConfigToolDetectionResult,
    modelTierAnalysis: ModelTierClassificationResult,
    routingDecision: RoutingDecisionResult,
    steps: Array<{ step: string; duration: number; success: boolean }>,
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
  private createErrorResult(error: string, steps: Array<{ step: string; duration: number; success: boolean }>): ConfigClassificationResult {
    const emptyToken: ProtocolTokenCalculationResult = {
      totalTokens: 0,
      messageTokens: 0,
      systemTokens: 0,
      toolTokens: 0,
      breakdown: { messages: 0, system: 0, tools: 0 },
      protocol: 'unknown'
    };
    const emptyTool: ConfigToolDetectionResult = {
      hasTools: false,
      toolCount: 0,
      toolTypes: [],
      toolCategories: { webSearch: false, codeExecution: false, fileSearch: false, dataAnalysis: false, general: false },
      complexity: { low: 0, medium: 0, high: 0 },
      recommendations: { suggestedRoute: 'default', reasoning: 'error', confidence: 0 },
      configBased: true
    };
    const emptyTier: ModelTierClassificationResult = {
      tier: 'basic',
      confidence: 0,
      reasoning: 'error',
      maxAllowedTokens: 0,
      supportedFeatures: [],
      recommendations: { suitableForTask: true, alternativeTiers: [], warnings: [] },
      factors: { patternMatch: false, tokenCapacity: false, featureCompatibility: false, userPreference: false },
      configBased: true,
    };
    const emptyRouting: RoutingDecisionResult = {
      route: 'default',
      modelTier: 'basic',
      confidence: 0,
      reasoning: 'error',
      factors: { tokenBased: false, toolBased: false, modelBased: false, complexityBased: false },
      alternativeRoutes: [],
      configBased: true
    };
    return {
      success: false,
      route: 'default',
      modelTier: 'basic',
      confidence: 0,
      reasoning: error,
      analysis: {
        protocol: 'unknown',
        tokenAnalysis: emptyToken,
        toolAnalysis: emptyTool,
        modelTierAnalysis: emptyTier,
        routingDecision: emptyRouting
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
  private extractModelFromRequest(
    request: UnknownObject,
    protocolConfig: { modelField: string }
  ): string {
    // 从请求中提取模型字段
    return (request as Record<string, unknown>)[protocolConfig.modelField] as string || 'unknown-model';
  }

  /**
   * 从请求中提取最大Token数
   */
  private extractMaxTokensFromRequest(
    request: UnknownObject,
    protocolConfig: { maxTokensField: string }
  ): number | undefined {
    // 从请求中提取最大Token字段
    return (request as Record<string, unknown>)[protocolConfig.maxTokensField] as number | undefined;
  }

  /**
   * 获取分类器状态
   */
  getStatus(): {
    ready: boolean;
    protocols: string[];
    tokenCalculators: number;
    toolDetectors: number;
    configValidation: ReturnType<ConfigRoutingDecision['validateConfig']>;
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
  static fromModuleConfig(classificationConfig: UnknownObject): ConfigRequestClassifier {
    const cfg = classificationConfig as Record<string, unknown>;
    const config: ConfigClassifierConfig = {
      protocolMapping: cfg.protocolMapping as ConfigClassifierConfig['protocolMapping'],
      protocolHandlers: cfg.protocolHandlers as ConfigClassifierConfig['protocolHandlers'],
      modelTiers: cfg.modelTiers as ConfigClassifierConfig['modelTiers'],
      routingDecisions: cfg.routingDecisions as ConfigClassifierConfig['routingDecisions'],
      confidenceThreshold: (cfg.confidenceThreshold as number) || 60,
      thinkingKeywords: (cfg.thinkingKeywords as string[]) || [],
      longContextThresholdTokens: typeof cfg.longContextThresholdTokens === 'number'
        ? (cfg.longContextThresholdTokens as number)
        : undefined
    };

    return new ConfigRequestClassifier(config);
  }
}
