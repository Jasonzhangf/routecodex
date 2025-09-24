/**
 * Request Classifier
 * 请求分类器 - 整合Token计算、工具检测和模型类别解析
 */

import { TokenCalculator } from './token-calculator.js';
import { ToolDetector } from './tool-detector.js';
import { ModelCategoryResolver } from './model-category-resolver.js';
import type { ModelCategoryConfig } from './model-category-resolver.js';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

export interface ClassificationInput {
  messages: ChatCompletionMessageParam[];
  model?: string;
  tools?: ChatCompletionTool[];
  thinking?: boolean;
  metadata?: Record<string, any>;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  reasoning: string;
  factors: ClassificationFactors;
  recommendations: ClassificationRecommendations;
  metadata: ClassificationMetadata;
}

export interface ClassificationFactors {
  tokenCount: number;
  tokenCategory: 'short' | 'medium' | 'long' | 'very_long';
  hasTools: boolean;
  toolTypes: string[];
  toolComplexity: number;
  modelType: string;
  thinkingMode: boolean;
  messageCount: number;
  complexity: number;
}

export interface ClassificationRecommendations {
  suggestedRoute: string;
  alternativeRoutes: Array<{
    route: string;
    confidence: number;
    reasoning: string;
  }>;
  optimization: {
    priority: 'low' | 'medium' | 'high';
    suggestions: string[];
  };
}

export interface ClassificationMetadata {
  processingTime: number;
  matchedRules: string[];
  fallbackUsed: boolean;
  confidenceFactors: {
    tokenAnalysis: number;
    toolAnalysis: number;
    modelAnalysis: number;
    contextAnalysis: number;
  };
  version: string;
}

export class RequestClassifier {
  private tokenCalculator: TokenCalculator;
  private toolDetector: ToolDetector;
  private modelCategoryResolver: ModelCategoryResolver;

  constructor(modelCategoryConfig: ModelCategoryConfig) {
    this.tokenCalculator = new TokenCalculator();
    this.toolDetector = new ToolDetector();
    this.modelCategoryResolver = new ModelCategoryResolver(modelCategoryConfig);
  }

  /**
   * 分类请求
   */
  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const startTime = Date.now();

    // 1. Token计算
    const tokenAnalysis = this.tokenCalculator.getDetailedEstimate({
      messages: input.messages,
      tools: input.tools
    });

    // 2. 工具检测
    const toolAnalysis = this.toolDetector.getDetailedAnalysis(
      input.tools,
      input.messages
    );

    // 3. 模型类别解析
    const modelCategoryResult = this.modelCategoryResolver.resolveCategory(
      input.model || 'unknown',
      {
        tokenCount: tokenAnalysis.calculation.totalTokens,
        hasTools: toolAnalysis.detection.hasTools,
        toolTypes: toolAnalysis.detection.toolTypes,
        thinking: input.thinking
      }
    );

    // 4. 综合分析
    const factors = this.analyzeFactors(tokenAnalysis, toolAnalysis, input);
    const recommendations = this.generateRecommendations(factors, modelCategoryResult);
    const confidence = this.calculateConfidence(factors, modelCategoryResult);

    const processingTime = Date.now() - startTime;
    const metadata = this.generateMetadata(
      processingTime,
      modelCategoryResult,
      tokenAnalysis,
      toolAnalysis
    );

    return {
      category: modelCategoryResult.category,
      confidence,
      reasoning: this.generateReasoning(factors, modelCategoryResult),
      factors,
      recommendations,
      metadata
    };
  }

  /**
   * 分析分类因素
   */
  private analyzeFactors(
    tokenAnalysis: any,
    toolAnalysis: any,
    input: ClassificationInput
  ): ClassificationFactors {
    const totalTokens = tokenAnalysis.calculation.totalTokens;
    const tokenCategory = this.categorizeTokenCount(totalTokens);
    const toolComplexity = toolAnalysis.detection.complexity.medium;
    const complexity = this.calculateOverallComplexity(
      totalTokens,
      toolAnalysis.detection.hasTools,
      toolComplexity,
      input.messages.length
    );

    return {
      tokenCount: totalTokens,
      tokenCategory,
      hasTools: toolAnalysis.detection.hasTools,
      toolTypes: toolAnalysis.detection.toolTypes,
      toolComplexity,
      modelType: input.model || 'unknown',
      thinkingMode: input.thinking || false,
      messageCount: input.messages.length,
      complexity
    };
  }

  /**
   * 生成推荐
   */
  private generateRecommendations(
    factors: ClassificationFactors,
    modelCategoryResult: any
  ): ClassificationRecommendations {
    const suggestedRoute = modelCategoryResult.definition.routeTarget;
    const alternativeRoutes = this.generateAlternativeRoutes(factors);

    return {
      suggestedRoute,
      alternativeRoutes,
      optimization: {
        priority: this.determinePriority(factors),
        suggestions: this.generateOptimizationSuggestions(factors)
      }
    };
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(
    factors: ClassificationFactors,
    modelCategoryResult: any
  ): number {
    let confidence = modelCategoryResult.confidence;

    // 基于匹配的规则调整置信度
    if (modelCategoryResult.matchedRules.length > 0) {
      confidence += 10;
    }

    // 基于回退使用调整置信度
    if (modelCategoryResult.fallbackUsed) {
      confidence -= 20;
    }

    // 基于因素一致性调整置信度
    if (this.isConsistentClassification(factors, modelCategoryResult.category)) {
      confidence += 5;
    }

    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * 生成推理说明
   */
  private generateReasoning(
    factors: ClassificationFactors,
    modelCategoryResult: any
  ): string {
    const reasons = [];

    // 模型类别推理
    reasons.push(`Model category: ${modelCategoryResult.category}`);
    if (modelCategoryResult.matchedRules.length > 0) {
      reasons.push(`Matched rules: ${modelCategoryResult.matchedRules.join(', ')}`);
    }

    // Token分析推理
    reasons.push(`Token count: ${factors.tokenCount} (${factors.tokenCategory})`);

    // 工具分析推理
    if (factors.hasTools) {
      reasons.push(`Tools detected: ${factors.toolTypes.join(', ')}`);
      reasons.push(`Tool complexity: ${factors.toolComplexity}`);
    }

    // 特殊模式推理
    if (factors.thinkingMode) {
      reasons.push('Thinking mode enabled');
    }

    return reasons.join('; ');
  }

  /**
   * 生成元数据
   */
  private generateMetadata(
    processingTime: number,
    modelCategoryResult: any,
    tokenAnalysis: any,
    toolAnalysis: any
  ): ClassificationMetadata {
    return {
      processingTime,
      matchedRules: modelCategoryResult.matchedRules,
      fallbackUsed: modelCategoryResult.fallbackUsed,
      confidenceFactors: {
        tokenAnalysis: this.getTokenConfidence(tokenAnalysis),
        toolAnalysis: this.getToolConfidence(toolAnalysis),
        modelAnalysis: modelCategoryResult.confidence,
        contextAnalysis: this.getContextConfidence(tokenAnalysis, toolAnalysis)
      },
      version: '1.0.0'
    };
  }

  /**
   * Token数量分类
   */
  private categorizeTokenCount(tokenCount: number): 'short' | 'medium' | 'long' | 'very_long' {
    if (tokenCount < 1000) {return 'short';}
    if (tokenCount < 8000) {return 'medium';}
    if (tokenCount < 32000) {return 'long';}
    return 'very_long';
  }

  /**
   * 计算整体复杂度
   */
  private calculateOverallComplexity(
    tokenCount: number,
    hasTools: boolean,
    toolComplexity: number,
    messageCount: number
  ): number {
    let complexity = 0;

    // Token复杂度
    if (tokenCount > 32000) {complexity += 40;}
    else if (tokenCount > 8000) {complexity += 20;}
    else if (tokenCount > 1000) {complexity += 10;}

    // 工具复杂度
    if (hasTools) {
      complexity += 15;
      complexity += Math.min(toolComplexity, 25);
    }

    // 消息复杂度
    if (messageCount > 10) {complexity += 10;}
    else if (messageCount > 5) {complexity += 5;}

    return Math.min(100, complexity);
  }

  /**
   * 生成备选路由
   */
  private generateAlternativeRoutes(factors: ClassificationFactors): Array<{
    route: string;
    confidence: number;
    reasoning: string;
  }> {
    const alternatives = [];

    // 基于Token数量提供备选
    if (factors.tokenCategory === 'very_long') {
      alternatives.push({
        route: 'longContext',
        confidence: 80,
        reasoning: 'Very long token count suggests long context model'
      });
    }

    // 基于工具使用提供备选
    if (factors.hasTools && factors.toolTypes.includes('webSearch')) {
      alternatives.push({
        route: 'webSearch',
        confidence: 75,
        reasoning: 'Web search tools detected'
      });
    }

    // 基于思考模式提供备选
    if (factors.thinkingMode) {
      alternatives.push({
        route: 'thinking',
        confidence: 85,
        reasoning: 'Thinking mode enabled'
      });
    }

    // 默认备选
    alternatives.push({
      route: 'default',
      confidence: 50,
      reasoning: 'Default fallback route'
    });

    return alternatives;
  }

  /**
   * 确定优化优先级
   */
  private determinePriority(factors: ClassificationFactors): 'low' | 'medium' | 'high' {
    if (factors.complexity > 70 || factors.tokenCategory === 'very_long') {
      return 'high';
    }
    if (factors.complexity > 40 || factors.tokenCategory === 'long') {
      return 'medium';
    }
    return 'low';
  }

  /**
   * 生成优化建议
   */
  private generateOptimizationSuggestions(factors: ClassificationFactors): string[] {
    const suggestions = [];

    if (factors.tokenCategory === 'very_long') {
      suggestions.push('Consider using a model with larger context window');
    }

    if (factors.hasTools && factors.toolComplexity > 20) {
      suggestions.push('Consider using a model optimized for complex tool usage');
    }

    if (factors.thinkingMode) {
      suggestions.push('Consider using a model with enhanced reasoning capabilities');
    }

    if (factors.messageCount > 10) {
      suggestions.push('Consider using a model with better conversation memory');
    }

    return suggestions;
  }

  /**
   * 检查分类一致性
   */
  private isConsistentClassification(factors: ClassificationFactors, category: string): boolean {
    // 检查分类结果与因素是否一致
    if (category === 'longContext' && factors.tokenCategory === 'short') {
      return false;
    }

    if (category === 'webSearch' && !factors.toolTypes.includes('webSearch')) {
      return false;
    }

    if (category === 'thinking' && !factors.thinkingMode) {
      return false;
    }

    return true;
  }

  /**
   * 获取Token分析置信度
   */
  private getTokenConfidence(tokenAnalysis: any): number {
    const { estimates, recommendations } = tokenAnalysis;

    if (recommendations.category === 'very_long') {return 90;}
    if (recommendations.category === 'long') {return 80;}
    if (recommendations.category === 'medium') {return 70;}
    return 60;
  }

  /**
   * 获取工具分析置信度
   */
  private getToolConfidence(toolAnalysis: any): number {
    const { detection } = toolAnalysis;

    if (!detection.hasTools) {return 50;}

    if (detection.recommendations.confidence > 0.8) {return 90;}
    if (detection.recommendations.confidence > 0.6) {return 70;}
    return 60;
  }

  /**
   * 获取上下文分析置信度
   */
  private getContextConfidence(tokenAnalysis: any, toolAnalysis: any): number {
    const tokenConfidence = this.getTokenConfidence(tokenAnalysis);
    const toolConfidence = this.getToolConfidence(toolAnalysis);

    return Math.min(100, (tokenConfidence + toolConfidence) / 2);
  }

  /**
   * 批量分类请求
   */
  async classifyBatch(inputs: ClassificationInput[]): Promise<ClassificationResult[]> {
    const results = await Promise.all(
      inputs.map(input => this.classify(input))
    );

    // 添加批处理分析
    return this.analyzeBatchResults(results);
  }

  /**
   * 分析批处理结果
   */
  private analyzeBatchResults(results: ClassificationResult[]): ClassificationResult[] {
    // 这里可以添加批处理级别的分析逻辑
    // 例如：检测批处理中的模式、优化建议等

    return results;
  }

  /**
   * 获取分类器统计信息
   */
  getStatistics(): {
    version: string;
    capabilities: string[];
    supportedFeatures: string[];
    performance: {
      averageProcessingTime: number;
      accuracy: number;
    };
  } {
    return {
      version: '1.0.0',
      capabilities: [
        'Token estimation',
        'Tool detection',
        'Model categorization',
        'Rule-based classification',
        'Context-aware routing'
      ],
      supportedFeatures: [
        'OpenAI format support',
        'Batch processing',
        'Confidence scoring',
        'Alternative routing suggestions'
      ],
      performance: {
        averageProcessingTime: 5, // ms
        accuracy: 0.85 // estimated
      }
    };
  }
}