/**
 * Tool Detector
 * 工具检测器 - 检测OpenAI请求中的工具使用情况
 */

import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface ToolDetectionResult {
  hasTools: boolean;
  toolCount: number;
  toolTypes: string[];
  toolCategories: {
    webSearch: boolean;
    codeExecution: boolean;
    fileSearch: boolean;
    dataAnalysis: boolean;
    general: boolean;
  };
  complexity: {
    low: number;
    medium: number;
    high: number;
  };
  recommendations: {
    suggestedRoute: string;
    reasoning: string;
    confidence: number;
  };
}

export class ToolDetector {
  // 工具类型检测模式
  private static readonly TOOL_TYPE_PATTERNS = {
    webSearch: [
      'web_search',
      'web search',
      'search',
      'browse',
      'internet',
      'online'
    ],
    codeExecution: [
      'code',
      'execute',
      'run',
      'bash',
      'python',
      'javascript',
      'interpreter',
      'sandbox'
    ],
    fileSearch: [
      'file',
      'search',
      'read',
      'write',
      'document',
      'pdf',
      'text'
    ],
    dataAnalysis: [
      'data',
      'analysis',
      'chart',
      'graph',
      'plot',
      'statistics',
      'math'
    ]
  };

  /**
   * 检测请求中的工具使用情况
   */
  detect(
    tools?: ChatCompletionTool[],
    messages?: ChatCompletionMessageParam[]
  ): ToolDetectionResult {
    // 检测工具定义
    const toolDefinitionResult = this.detectToolDefinitions(tools);

    // 检测消息中的工具调用
    const toolCallResult = this.detectToolCalls(messages);

    // 合并检测结果
    const hasTools = toolDefinitionResult.hasTools || toolCallResult.hasToolCalls;
    const allToolTypes = [...toolDefinitionResult.toolTypes, ...toolCallResult.toolTypes];

    // 分析工具类别
    const categories = this.categorizeTools(allToolTypes);

    // 计算复杂度
    const complexity = this.calculateComplexity(toolDefinitionResult, toolCallResult, categories);

    // 生成推荐
    const recommendations = this.generateRecommendations(hasTools, categories, complexity);

    return {
      hasTools,
      toolCount: toolDefinitionResult.toolCount + toolCallResult.toolCallCount,
      toolTypes: [...new Set(allToolTypes)], // 去重
      toolCategories: categories,
      complexity,
      recommendations
    };
  }

  /**
   * 检测工具定义
   */
  private detectToolDefinitions(tools?: ChatCompletionTool[]): {
    hasTools: boolean;
    toolCount: number;
    toolTypes: string[];
  } {
    if (!tools || tools.length === 0) {
      return { hasTools: false, toolCount: 0, toolTypes: [] };
    }

    const toolTypes: string[] = [];

    for (const tool of tools) {
      // 基于工具名称和描述检测类型
      if (tool.type === 'function') {
        const detectedType = this.detectToolType(tool.function.name, tool.function.description);
        if (detectedType) {
          toolTypes.push(detectedType);
        }
      }
    }

    return {
      hasTools: true,
      toolCount: tools.length,
      toolTypes
    };
  }

  /**
   * 检测工具调用
   */
  private detectToolCalls(messages?: ChatCompletionMessageParam[]): {
    hasToolCalls: boolean;
    toolCallCount: number;
    toolTypes: string[];
  } {
    if (!messages || messages.length === 0) {
      return { hasToolCalls: false, toolCallCount: 0, toolTypes: [] };
    }

    const toolTypes: string[] = [];
    let toolCallCount = 0;

    for (const message of messages) {
      if (message.role === 'assistant' && message.tool_calls) {
        toolCallCount += message.tool_calls.length;

        for (const toolCall of message.tool_calls) {
          if (toolCall.type === 'function') {
            const detectedType = this.detectToolType(toolCall.function.name);
            if (detectedType) {
              toolTypes.push(detectedType);
            }
          }
        }
      }

      if (message.role === 'tool') {
        toolCallCount++;
      }
    }

    return {
      hasToolCalls: toolCallCount > 0,
      toolCallCount,
      toolTypes
    };
  }

  /**
   * 检测单个工具的类型
   */
  private detectToolType(name?: string, description?: string): string | null {
    if (!name && !description) {
      return null;
    }

    const textToAnalyze = `${name || ''} ${description || ''}`.toLowerCase();

    // 检测各种工具类型
    for (const [category, patterns] of Object.entries(ToolDetector.TOOL_TYPE_PATTERNS)) {
      for (const pattern of patterns) {
        if (textToAnalyze.includes(pattern)) {
          return category;
        }
      }
    }

    // 默认归类为通用工具
    return 'general';
  }

  /**
   * 对工具进行分类
   */
  private categorizeTools(toolTypes: string[]): {
    webSearch: boolean;
    codeExecution: boolean;
    fileSearch: boolean;
    dataAnalysis: boolean;
    general: boolean;
  } {
    const categories = {
      webSearch: false,
      codeExecution: false,
      fileSearch: false,
      dataAnalysis: false,
      general: false
    };

    for (const toolType of toolTypes) {
      if (toolType in categories) {
        categories[toolType as keyof typeof categories] = true;
      } else {
        categories.general = true;
      }
    }

    return categories;
  }

  /**
   * 计算工具使用的复杂度
   */
  private calculateComplexity(
    toolDefinitions: { hasTools: boolean; toolCount: number },
    toolCalls: { hasToolCalls: boolean; toolCallCount: number },
    categories: any
  ): {
    low: number;
    medium: number;
    high: number;
  } {
    let complexityScore = 0;

    // 基于工具数量的复杂度
    if (toolDefinitions.hasTools) {
      complexityScore += Math.min(toolDefinitions.toolCount * 2, 10);
    }

    // 基于工具调用的复杂度
    if (toolCalls.hasToolCalls) {
      complexityScore += Math.min(toolCalls.toolCallCount * 3, 15);
    }

    // 基于工具类型的复杂度
    if (categories.webSearch) complexityScore += 5;
    if (categories.codeExecution) complexityScore += 8;
    if (categories.dataAnalysis) complexityScore += 6;
    if (categories.fileSearch) complexityScore += 4;

    // 计算不同级别的复杂度
    return {
      low: Math.max(0, complexityScore * 0.8),
      medium: complexityScore,
      high: Math.min(100, complexityScore * 1.2)
    };
  }

  /**
   * 生成路由推荐
   */
  private generateRecommendations(
    hasTools: boolean,
    categories: any,
    complexity: { low: number; medium: number; high: number }
  ): {
    suggestedRoute: string;
    reasoning: string;
    confidence: number;
  } {
    if (!hasTools) {
      return {
        suggestedRoute: 'default',
        reasoning: '无工具使用，使用默认模型',
        confidence: 0.9
      };
    }

    // 基于工具类型推荐路由
    if (categories.webSearch) {
      return {
        suggestedRoute: 'webSearch',
        reasoning: '检测到网络搜索工具，建议使用网络搜索优化模型',
        confidence: 0.8
      };
    }

    if (categories.codeExecution) {
      return {
        suggestedRoute: 'coding',
        reasoning: '检测到代码执行工具，建议使用代码优化模型',
        confidence: 0.8
      };
    }

    if (categories.dataAnalysis) {
      return {
        suggestedRoute: 'thinking',
        reasoning: '检测到数据分析工具，建议使用推理优化模型',
        confidence: 0.7
      };
    }

    // 基于复杂度推荐
    if (complexity.medium > 15) {
      return {
        suggestedRoute: 'thinking',
        reasoning: '工具使用复杂度较高，建议使用推理优化模型',
        confidence: 0.7
      };
    }

    return {
      suggestedRoute: 'default',
      reasoning: '检测到工具使用，复杂度适中，使用默认模型',
      confidence: 0.6
    };
  }

  /**
   * 获取详细的工具分析报告
   */
  getDetailedAnalysis(
    tools?: ChatCompletionTool[],
    messages?: ChatCompletionMessageParam[]
  ): {
    detection: ToolDetectionResult;
    insights: {
      primaryCategory: string;
      secondaryCategories: string[];
      complexityAssessment: 'simple' | 'moderate' | 'complex';
      toolUsagePattern: 'none' | 'definition_only' | 'usage_only' | 'full';
    };
    suggestions: {
      route: string;
      confidence: number;
      alternativeRoutes: Array<{
        route: string;
        confidence: number;
        reasoning: string;
      }>;
    };
  } {
    const detection = this.detect(tools, messages);

    // 分析洞察
    const primaryCategory = this.getPrimaryCategory(detection.toolCategories);
    const secondaryCategories = this.getSecondaryCategories(detection.toolCategories);
    const complexityAssessment = this.assessComplexity(detection.complexity.medium);
    const toolUsagePattern = this.assessToolUsagePattern(tools, messages);

    // 生成建议
    const suggestions = {
      route: detection.recommendations.suggestedRoute,
      confidence: detection.recommendations.confidence,
      alternativeRoutes: this.generateAlternativeRoutes(detection)
    };

    return {
      detection,
      insights: {
        primaryCategory,
        secondaryCategories,
        complexityAssessment,
        toolUsagePattern
      },
      suggestions
    };
  }

  private getPrimaryCategory(categories: any): string {
    if (categories.webSearch) return 'webSearch';
    if (categories.codeExecution) return 'codeExecution';
    if (categories.dataAnalysis) return 'dataAnalysis';
    if (categories.fileSearch) return 'fileSearch';
    if (categories.general) return 'general';
    return 'none';
  }

  private getSecondaryCategories(categories: any): string[] {
    const secondary: string[] = [];
    for (const [category, hasCategory] of Object.entries(categories)) {
      if (hasCategory && category !== 'general') {
        secondary.push(category);
      }
    }
    return secondary;
  }

  private assessComplexity(score: number): 'simple' | 'moderate' | 'complex' {
    if (score < 10) return 'simple';
    if (score < 25) return 'moderate';
    return 'complex';
  }

  private assessToolUsagePattern(tools?: ChatCompletionTool[], messages?: ChatCompletionMessageParam[]): 'none' | 'definition_only' | 'usage_only' | 'full' {
    const hasDefinitions = tools && tools.length > 0;
    const hasUsages = messages?.some(msg => msg.role === 'assistant' && msg.tool_calls);

    if (!hasDefinitions && !hasUsages) return 'none';
    if (hasDefinitions && !hasUsages) return 'definition_only';
    if (!hasDefinitions && hasUsages) return 'usage_only';
    return 'full';
  }

  private generateAlternativeRoutes(detection: ToolDetectionResult): Array<{
    route: string;
    confidence: number;
    reasoning: string;
  }> {
    const alternatives: Array<{
      route: string;
      confidence: number;
      reasoning: string;
    }> = [];

    if (detection.recommendations.suggestedRoute !== 'default') {
      alternatives.push({
        route: 'default',
        confidence: 0.5,
        reasoning: '默认模型作为备选方案'
      });
    }

    if (detection.complexity.medium > 15) {
      alternatives.push({
        route: 'thinking',
        confidence: 0.6,
        reasoning: '高复杂度工具使用建议使用推理模型'
      });
    }

    return alternatives;
  }
}