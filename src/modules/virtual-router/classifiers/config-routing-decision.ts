/**
 * Configuration-Driven Routing Decision
 * 基于配置的路由决策器
 */

export interface ModelTierConfig {
  description: string;
  models: string[];
  maxTokens: number;
  supportedFeatures: string[];
}

export interface RoutingDecisionConfig {
  [key: string]: {
    description: string;
    modelTier: 'basic' | 'advanced';
    tokenThreshold: number;
    toolTypes: string[];
    priority: number;
  };
}

export interface RoutingDecisionInput {
  protocol: string;
  endpoint: string;
  model: string;
  tokenCount: number;
  toolTypes: string[];
  hasTools: boolean;
  complexity: number;
  requestedMaxTokens?: number;
}

export interface RoutingDecisionResult {
  route: string;
  modelTier: 'basic' | 'advanced';
  confidence: number;
  reasoning: string;
  factors: {
    tokenBased: boolean;
    toolBased: boolean;
    modelBased: boolean;
    complexityBased: boolean;
  };
  alternativeRoutes: Array<{
    route: string;
    confidence: number;
    reasoning: string;
  }>;
  configBased: boolean;
}

export class ConfigRoutingDecision {
  private modelTiers: { [key: string]: ModelTierConfig };
  private routingDecisions: RoutingDecisionConfig;

  constructor(
    modelTiers: { [key: string]: ModelTierConfig },
    routingDecisions: RoutingDecisionConfig
  ) {
    this.modelTiers = modelTiers;
    this.routingDecisions = routingDecisions;
  }

  /**
   * 基于配置做出路由决策
   */
  makeDecision(input: RoutingDecisionInput): RoutingDecisionResult {
    const factors = {
      tokenBased: false,
      toolBased: false,
      modelBased: false,
      complexityBased: false
    };

    let bestRoute = 'default';
    let bestConfidence = 0;
    let bestReasoning = '默认路由';
    const alternativeRoutes: Array<{ route: string; confidence: number; reasoning: string }> = [];

    // 评估所有路由选项
    for (const [routeName, routeConfig] of Object.entries(this.routingDecisions)) {
      const evaluation = this.evaluateRoute(routeName, routeConfig, input);

      if (evaluation.confidence > bestConfidence) {
        // 将当前最佳路由添加到备选列表
        if (bestRoute !== 'default') {
          alternativeRoutes.push({
            route: bestRoute,
            confidence: bestConfidence,
            reasoning: bestReasoning
          });
        }

        bestRoute = routeName;
        bestConfidence = evaluation.confidence;
        bestReasoning = evaluation.reasoning;
        factors.tokenBased = evaluation.factors.tokenBased;
        factors.toolBased = evaluation.factors.toolBased;
        factors.modelBased = evaluation.factors.modelBased;
        factors.complexityBased = evaluation.factors.complexityBased;
      } else if (evaluation.confidence > 0.3) {
        // 添加到备选路由
        alternativeRoutes.push({
          route: routeName,
          confidence: evaluation.confidence,
          reasoning: evaluation.reasoning
        });
      }
    }

    // 按置信度排序备选路由
    alternativeRoutes.sort((a, b) => b.confidence - a.confidence);

    // 限制备选路由数量
    const limitedAlternatives = alternativeRoutes.slice(0, 3);

    return {
      route: bestRoute,
      modelTier: this.routingDecisions[bestRoute].modelTier,
      confidence: bestConfidence,
      reasoning: bestReasoning,
      factors,
      alternativeRoutes: limitedAlternatives,
      configBased: true
    };
  }

  /**
   * 评估单个路由的适用性
   */
  private evaluateRoute(
    routeName: string,
    routeConfig: RoutingDecisionConfig[string],
    input: RoutingDecisionInput
  ): {
    confidence: number;
    reasoning: string;
    factors: {
      tokenBased: boolean;
      toolBased: boolean;
      modelBased: boolean;
      complexityBased: boolean;
    };
  } {
    const factors = {
      tokenBased: false,
      toolBased: false,
      modelBased: false,
      complexityBased: false
    };

    let confidence = 0.4; // 提高基础置信度
    let reasoning = '';

    // 1. Token阈值评估 - 降低阈值要求，提高匹配度
    if (input.tokenCount >= routeConfig.tokenThreshold) {
      factors.tokenBased = true;
      confidence += 0.35; // 降低token权重
      reasoning += `Token数量(${input.tokenCount})达到阈值(${routeConfig.tokenThreshold}); `;
    } else if (routeName === 'longContext' && input.tokenCount >= 8000) {
      // 长上下文路由的特殊处理 - 降低门槛
      factors.tokenBased = true;
      confidence += 0.25;
      reasoning += `中等长度文本(${input.tokenCount} tokens); `;
    }

    // 2. 工具类型评估 - 增强权重
    if (input.hasTools && routeConfig.toolTypes.length > 0) {
      const matchingToolTypes = input.toolTypes.filter(toolType =>
        routeConfig.toolTypes.includes(toolType)
      );

      if (matchingToolTypes.length > 0) {
        factors.toolBased = true;
        confidence += 0.4; // 提高工具匹配权重
        reasoning += `匹配工具类型(${matchingToolTypes.join(', ')}); `;
      }
    }

    // 3. 模型层级评估
    const modelTier = this.getModelTier(input.model);
    if (modelTier === routeConfig.modelTier) {
      factors.modelBased = true;
      confidence += 0.25; // 提高模型匹配权重
      reasoning += `模型层级匹配(${modelTier}); `;
    }

    // 4. 复杂度评估 - 降低复杂度阈值
    if (input.complexity > 10 && routeConfig.priority >= 70) {
      factors.complexityBased = true;
      confidence += 0.15; // 提高复杂度权重
      reasoning += `高复杂度匹配高优先级路由; `;
    }

    // 5. 特殊路由的额外评估 - 增强特定场景识别
    if (routeName === 'webSearch' && input.toolTypes.includes('webSearch')) {
      confidence = Math.min(confidence + 0.3, 0.95); // 提高webSearch优先级
      reasoning += '网络搜索工具高优先级; ';
    }

    if (routeName === 'longContext') {
      // 长上下文路由的特殊处理
      if (input.tokenCount > 30000) {
        confidence = Math.min(confidence + 0.4, 0.95); // 超长文本强制路由
        reasoning += '超长上下文强制路由; ';
      } else if (input.tokenCount >= 8000) {
        confidence = Math.min(confidence + 0.3, 0.9); // 中等长度文本优先路由
        reasoning += '长上下文优先路由; ';
      }
    }

    if (routeName === 'coding' && (input.toolTypes.includes('codeExecution') || input.model.toLowerCase().includes('code'))) {
      confidence = Math.min(confidence + 0.3, 0.85); // 代码模型或工具强制路由
      reasoning += '代码执行工具强制路由; ';
    }

    if (routeName === 'thinking' && (input.toolTypes.includes('dataAnalysis') || input.model.toLowerCase().includes('thinking'))) {
      confidence = Math.min(confidence + 0.25, 0.8); // 思考模型或数据分析工具强制路由
      reasoning += '数据分析工具强制路由; ';
    }

    if (routeName === 'vision' && (input.model.toLowerCase().includes('vision') || input.model.toLowerCase().includes('vl'))) {
      confidence = Math.min(confidence + 0.35, 0.9); // 视觉模型强制路由
      reasoning += '视觉模型强制路由; ';
    }

    if (routeName === 'background' && input.complexity < 20) {
      confidence = Math.min(confidence + 0.2, 0.7); // 低复杂度后台任务
      reasoning += '低复杂度后台任务; ';
    }

    // 6. 优先级调整 - 确保各类路由都能获得足够高的置信度
    if (routeName !== 'default') {
      confidence = Math.max(confidence * (routeConfig.priority / 80), 0.5); // 降低优先级影响，确保非default路由有基础置信度
    }

    // 7. 确保长上下文在高token数量时获得足够高的置信度
    if (routeName === 'longContext' && input.tokenCount >= 8000) {
      confidence = Math.max(confidence, 0.75); // 降低强制阈值
    }

    return {
      confidence: Math.min(confidence, 0.99),
      reasoning: reasoning || '基本路由匹配',
      factors
    };
  }

  /**
   * 获取模型层级
   */
  private getModelTier(model: string): 'basic' | 'advanced' {
    // 检查高级模型
    for (const advancedModel of this.modelTiers.advanced.models) {
      if (model.toLowerCase().includes(advancedModel.toLowerCase())) {
        return 'advanced';
      }
    }

    // 检查基础模型
    for (const basicModel of this.modelTiers.basic.models) {
      if (model.toLowerCase().includes(basicModel.toLowerCase())) {
        return 'basic';
      }
    }

    // 默认为基础模型
    return 'basic';
  }

  /**
   * 验证路由决策配置
   */
  validateConfig(): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 验证模型层级配置
    if (!this.modelTiers.basic || !this.modelTiers.advanced) {
      errors.push('Missing required model tiers: basic and advanced');
    }

    // 验证路由决策配置
    if (!this.routingDecisions || Object.keys(this.routingDecisions).length === 0) {
      errors.push('No routing decisions configured');
    }

    // 验证必要的路由
    const requiredRoutes = ['default', 'longContext', 'thinking', 'coding', 'webSearch'];
    for (const route of requiredRoutes) {
      if (!this.routingDecisions[route]) {
        warnings.push(`Missing recommended route: ${route}`);
      }
    }

    // 验证路由配置完整性
    for (const [routeName, config] of Object.entries(this.routingDecisions)) {
      if (!config.description) {
        warnings.push(`Route ${routeName} missing description`);
      }
      if (!config.modelTier || !['basic', 'advanced'].includes(config.modelTier)) {
        errors.push(`Route ${routeName} has invalid model tier: ${config.modelTier}`);
      }
      if (typeof config.tokenThreshold !== 'number' || config.tokenThreshold < 0) {
        errors.push(`Route ${routeName} has invalid token threshold: ${config.tokenThreshold}`);
      }
      if (!Array.isArray(config.toolTypes)) {
        errors.push(`Route ${routeName} has invalid tool types configuration`);
      }
      if (typeof config.priority !== 'number' || config.priority < 0 || config.priority > 100) {
        errors.push(`Route ${routeName} has invalid priority: ${config.priority}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 获取路由决策统计信息
   */
  getRoutingStats(): {
    totalRoutes: number;
    basicTierRoutes: number;
    advancedTierRoutes: number;
    averagePriority: number;
    highestPriorityRoute: string;
    lowestPriorityRoute: string;
  } {
    const routes = Object.entries(this.routingDecisions);
    const basicTierRoutes = routes.filter(([_, config]) => config.modelTier === 'basic').length;
    const advancedTierRoutes = routes.filter(([_, config]) => config.modelTier === 'advanced').length;

    const priorities = routes.map(([_, config]) => config.priority);
    const averagePriority = priorities.reduce((sum, p) => sum + p, 0) / priorities.length;

    const highestPriorityRoute = routes.reduce((max, [name, config]) =>
      config.priority > max.priority ? { name, priority: config.priority } : max,
      { name: '', priority: -1 }
    ).name;

    const lowestPriorityRoute = routes.reduce((min, [name, config]) =>
      config.priority < min.priority ? { name, priority: config.priority } : min,
      { name: '', priority: 101 }
    ).name;

    return {
      totalRoutes: routes.length,
      basicTierRoutes,
      advancedTierRoutes,
      averagePriority,
      highestPriorityRoute,
      lowestPriorityRoute
    };
  }

  /**
   * 从模块配置创建路由决策器
   */
  static fromModuleConfig(classificationConfig: any): ConfigRoutingDecision {
    const modelTiers = classificationConfig.modelTiers;
    const routingDecisions = classificationConfig.routingDecisions;

    if (!modelTiers || !routingDecisions) {
      throw new Error('Missing required routing configuration');
    }

    return new ConfigRoutingDecision(modelTiers, routingDecisions);
  }
}