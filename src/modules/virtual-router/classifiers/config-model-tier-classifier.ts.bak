/**
 * Configuration-Driven Model Tier Classifier
 * 基于配置的模型层级分类器
 */

export interface EnhancedModelTierConfig {
  description: string;
  models: string[];
  maxTokens: number;
  supportedFeatures: string[];
  costMultiplier?: number;
  performanceMultiplier?: number;
  qualityMultiplier?: number;
  recommendedFor?: string[];
  notRecommendedFor?: string[];
}

export interface ModelTierClassificationInput {
  model: string;
  requestedMaxTokens?: number;
  context: {
    protocol: string;
    endpoint: string;
    hasTools?: boolean;
    estimatedTokens?: number;
    toolTypes?: string[];
    userPreferences?: {
      preferredTier?: 'basic' | 'advanced';
      costSensitive?: boolean;
      performanceCritical?: boolean;
      qualityCritical?: boolean;
    };
  };
}

export interface ModelTierClassificationResult {
  tier: 'basic' | 'advanced';
  confidence: number;
  reasoning: string;
  maxAllowedTokens: number;
  supportedFeatures: string[];
  recommendations: {
    suitableForTask: boolean;
    alternativeTiers: Array<{
      tier: 'basic' | 'advanced';
      reason: string;
      confidence: number;
    }>;
    warnings: string[];
  };
  factors: {
    patternMatch: boolean;
    tokenCapacity: boolean;
    featureCompatibility: boolean;
    userPreference: boolean;
  };
  configBased: boolean;
}

export class ConfigModelTierClassifier {
  private modelTiers: {
    basic: EnhancedModelTierConfig;
    advanced: EnhancedModelTierConfig;
  };
  private modelPatterns: Map<string, { tier: 'basic' | 'advanced'; confidence: number }>;

  constructor(modelTiers: { basic: EnhancedModelTierConfig; advanced: EnhancedModelTierConfig }) {
    this.modelTiers = modelTiers;
    this.modelPatterns = this.buildModelPatterns();
  }

  /**
   * 分类模型到层级
   */
  classify(input: ModelTierClassificationInput): ModelTierClassificationResult {
    const factors = {
      patternMatch: false,
      tokenCapacity: false,
      featureCompatibility: false,
      userPreference: false
    };

    let bestTier: 'basic' | 'advanced' = 'basic';
    let bestConfidence = 0.6; // 基础置信度
    let reasoning = '';

    // 1. 模式匹配
    const patternMatch = this.matchModelPattern(input.model);
    if (patternMatch) {
      bestTier = patternMatch.tier;
      bestConfidence = Math.max(bestConfidence, patternMatch.confidence);
      factors.patternMatch = true;
      reasoning += `模型模式匹配(${input.model} -> ${patternMatch.tier}); `;
    }

    // 2. Token容量检查
    const requiredTokens = input.requestedMaxTokens || input.context.estimatedTokens || 0;
    const tokenCapacity = this.checkTokenCapacity(requiredTokens, bestTier);
    if (!tokenCapacity.sufficient) {
      // Token容量不足，需要升级层级
      if (bestTier === 'basic' && this.checkTokenCapacity(requiredTokens, 'advanced').sufficient) {
        bestTier = 'advanced';
        bestConfidence = Math.max(bestConfidence, 0.8);
        reasoning += `Token容量不足，升级到高级模型; `;
      } else if (!this.checkTokenCapacity(requiredTokens, 'advanced').sufficient) {
        reasoning += `警告: 所选层级Token容量不足; `;
      }
    } else {
      factors.tokenCapacity = true;
      bestConfidence = Math.max(bestConfidence, 0.7);
      reasoning += `Token容量充足(${requiredTokens} <= ${this.modelTiers[bestTier].maxTokens}); `;
    }

    // 3. 功能兼容性检查
    const featureCompatibility = this.checkFeatureCompatibility(input.context, bestTier);
    if (featureCompatibility.compatible) {
      factors.featureCompatibility = true;
      bestConfidence = Math.max(bestConfidence, 0.8);
      reasoning += `功能兼容性良好; `;
    } else {
      // 功能不兼容，需要升级层级
      if (bestTier === 'basic' && this.checkFeatureCompatibility(input.context, 'advanced').compatible) {
        bestTier = 'advanced';
        bestConfidence = Math.max(bestConfidence, 0.9);
        reasoning += `功能需求升级到高级模型; `;
      }
    }

    // 4. 用户偏好检查
    const userPreference = this.checkUserPreference(input.context.userPreferences, bestTier);
    if (userPreference.match) {
      factors.userPreference = true;
      bestConfidence = Math.max(bestConfidence, userPreference.confidence);
      reasoning += `用户偏好匹配(${userPreference.reason}); `;
    }

    // 5. 综合置信度计算
    if (factors.patternMatch || factors.tokenCapacity || factors.featureCompatibility) {
      bestConfidence = Math.min(bestConfidence, 0.95);
    } else {
      bestConfidence = Math.max(bestConfidence, 0.5); // 最小置信度
    }

    // 6. 生成建议和警告
    const recommendations = this.generateRecommendations(input, bestTier);

    return {
      tier: bestTier,
      confidence: bestConfidence,
      reasoning: reasoning || '默认模型层级分类',
      maxAllowedTokens: this.modelTiers[bestTier].maxTokens,
      supportedFeatures: this.modelTiers[bestTier].supportedFeatures,
      recommendations,
      factors,
      configBased: true
    };
  }

  /**
   * 构建模型模式匹配
   */
  private buildModelPatterns(): Map<string, { tier: 'basic' | 'advanced'; confidence: number }> {
    const patterns = new Map<string, { tier: 'basic' | 'advanced'; confidence: number }>();

    // 基础模型模式
    for (const model of this.modelTiers.basic.models) {
      const pattern = model.toLowerCase().replace(/\*/g, '.*');
      patterns.set(pattern, { tier: 'basic', confidence: 0.9 });
    }

    // 高级模型模式
    for (const model of this.modelTiers.advanced.models) {
      const pattern = model.toLowerCase().replace(/\*/g, '.*');
      patterns.set(pattern, { tier: 'advanced', confidence: 0.9 });
    }

    return patterns;
  }

  /**
   * 匹配模型模式
   */
  private matchModelPattern(modelName: string): { tier: 'basic' | 'advanced'; confidence: number } | null {
    const modelLower = modelName.toLowerCase();

    for (const [pattern, match] of this.modelPatterns) {
      const regex = new RegExp(pattern);
      if (regex.test(modelLower)) {
        return match;
      }
    }

    return null;
  }

  /**
   * 检查Token容量
   */
  private checkTokenCapacity(
    requiredTokens: number,
    tier: 'basic' | 'advanced'
  ): { sufficient: boolean; available: number; required: number } {
    const available = this.modelTiers[tier].maxTokens;
    return {
      sufficient: requiredTokens <= available,
      available,
      required: requiredTokens
    };
  }

  /**
   * 检查功能兼容性
   */
  private checkFeatureCompatibility(
    context: ModelTierClassificationInput['context'],
    tier: 'basic' | 'advanced'
  ): { compatible: boolean; missingFeatures: string[] } {
    const supportedFeatures = this.modelTiers[tier].supportedFeatures;
    const requiredFeatures: string[] = [];

    // 基于上下文推断所需功能
    if (context.hasTools) {
      requiredFeatures.push('tool_use');
    }

    if (context.toolTypes?.includes('codeExecution')) {
      requiredFeatures.push('coding');
    }

    if (context.toolTypes?.includes('dataAnalysis')) {
      requiredFeatures.push('reasoning');
    }

    const missingFeatures = requiredFeatures.filter(feature =>
      !supportedFeatures.some(supported => supported.toLowerCase().includes(feature.toLowerCase()))
    );

    return {
      compatible: missingFeatures.length === 0,
      missingFeatures
    };
  }

  /**
   * 检查用户偏好
   */
  private checkUserPreference(
    preferences: ModelTierClassificationInput['context']['userPreferences'],
    currentTier: 'basic' | 'advanced'
  ): { match: boolean; confidence: number; reason: string } {
    if (!preferences) {
      return { match: false, confidence: 0, reason: '无用户偏好设置' };
    }

    if (preferences.preferredTier && preferences.preferredTier === currentTier) {
      return { match: true, confidence: 0.95, reason: '用户明确偏好的层级' };
    }

    if (preferences.costSensitive && currentTier === 'basic') {
      return { match: true, confidence: 0.8, reason: '用户成本敏感，匹配基础层级' };
    }

    if (preferences.performanceCritical && currentTier === 'advanced') {
      return { match: true, confidence: 0.85, reason: '用户关注性能，匹配高级层级' };
    }

    if (preferences.qualityCritical && currentTier === 'advanced') {
      return { match: true, confidence: 0.9, reason: '用户关注质量，匹配高级层级' };
    }

    return { match: false, confidence: 0, reason: '用户偏好不匹配' };
  }

  /**
   * 生成建议和警告
   */
  private generateRecommendations(
    input: ModelTierClassificationInput,
    currentTier: 'basic' | 'advanced'
  ): ModelTierClassificationResult['recommendations'] {
    const alternativeTiers: Array<{
      tier: 'basic' | 'advanced';
      reason: string;
      confidence: number;
    }> = [];

    const warnings: string[] = [];

    // 检查是否适合任务
    const suitableForTask = this.isSuitableForTask(input, currentTier);

    // 生成替代层级建议
    const otherTier = currentTier === 'basic' ? 'advanced' : 'basic';
    const otherTierClassification = this.classify({
      ...input,
      context: {
        ...input.context,
        userPreferences: {
          ...input.context.userPreferences,
          preferredTier: otherTier
        }
      }
    });

    if (otherTierClassification.confidence > 0.6) {
      alternativeTiers.push({
        tier: otherTier,
        reason: `替代${otherTier}层级`,
        confidence: otherTierClassification.confidence * 0.8
      });
    }

    // 生成警告
    const tokenCapacity = this.checkTokenCapacity(
      input.requestedMaxTokens || input.context.estimatedTokens || 0,
      currentTier
    );
    if (!tokenCapacity.sufficient) {
      warnings.push(`Token容量可能不足: 需要${tokenCapacity.required}, 可用${tokenCapacity.available}`);
    }

    const featureCompatibility = this.checkFeatureCompatibility(input.context, currentTier);
    if (!featureCompatibility.compatible) {
      warnings.push(`功能不兼容: 缺少 ${featureCompatibility.missingFeatures.join(', ')}`);
    }

    if (input.context.userPreferences?.costSensitive && currentTier === 'advanced') {
      warnings.push('用户成本敏感但使用了高级模型');
    }

    return {
      suitableForTask,
      alternativeTiers,
      warnings
    };
  }

  /**
   * 检查是否适合任务
   */
  private isSuitableForTask(
    input: ModelTierClassificationInput,
    tier: 'basic' | 'advanced'
  ): boolean {
    const tierConfig = this.modelTiers[tier];

    // 检查推荐用途
    if (tierConfig.recommendedFor) {
      // 这里可以根据任务类型进行更详细的检查
      // 简化版本：总是返回true
      return true;
    }

    // 检查不推荐用途
    if (tierConfig.notRecommendedFor) {
      // 简化版本：总是返回true
      return true;
    }

    return true;
  }

  /**
   * 获取模型层级统计信息
   */
  getTierStats(): {
    basic: {
      modelCount: number;
      maxTokens: number;
      featureCount: number;
      models: string[];
    };
    advanced: {
      modelCount: number;
      maxTokens: number;
      featureCount: number;
      models: string[];
    };
    totalPatterns: number;
  } {
    const tiers = this.modelTiers as { basic: EnhancedModelTierConfig; advanced: EnhancedModelTierConfig };
    return {
      basic: {
        modelCount: tiers.basic.models.length,
        maxTokens: tiers.basic.maxTokens,
        featureCount: tiers.basic.supportedFeatures.length,
        models: tiers.basic.models
      },
      advanced: {
        modelCount: tiers.advanced.models.length,
        maxTokens: tiers.advanced.maxTokens,
        featureCount: tiers.advanced.supportedFeatures.length,
        models: tiers.advanced.models
      },
      totalPatterns: this.modelPatterns.size
    };
  }

  /**
   * 从模块配置创建模型层级分类器
   */
  static fromModuleConfig(classificationConfig: Record<string, unknown>): ConfigModelTierClassifier {
    const modelTiers = classificationConfig['modelTiers'] as { basic?: EnhancedModelTierConfig; advanced?: EnhancedModelTierConfig };
    if (!modelTiers || !modelTiers.basic || !modelTiers.advanced) {
      throw new Error('Invalid model tiers configuration');
    }

    // 增强配置
    const enhancedTiers: { basic: EnhancedModelTierConfig; advanced: EnhancedModelTierConfig } = {
      basic: {
        ...(modelTiers?.basic || {}),
        costMultiplier: 1.0,
        performanceMultiplier: 1.0,
        qualityMultiplier: 1.0
      },
      advanced: {
        ...(modelTiers?.advanced || {}),
        costMultiplier: 1.0,
        performanceMultiplier: 1.0,
        qualityMultiplier: 1.0
      }
    };

    return new ConfigModelTierClassifier(enhancedTiers);
  }
}
