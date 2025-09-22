/**
 * Request Transformer
 * 请求转换器 - 负责具体的请求字段转换
 */

import type {
  OpenAIRequest,
  RequestMeta,
  ConversionContext,
  ConversionStep,
  ConversionResult,
  ConversionDebugInfo,
  ConversionMetrics
} from './types.js';
import { FieldMappingRules } from './field-mapping-rules.js';

/**
 * 请求转换器
 */
export class RequestTransformer {
  private fieldMappingRules: FieldMappingRules;

  constructor() {
    this.fieldMappingRules = new FieldMappingRules();
  }

  /**
   * 转换OpenAI请求
   */
  async transformOpenAIRequest(
    request: OpenAIRequest,
    context: ConversionContext
  ): Promise<ConversionResult> {
    const startTime = Date.now();
    const conversionId = this.generateConversionId();
    const conversionTrace: ConversionStep[] = [];

    try {
      // 创建转换结果的副本
      const convertedRequest = { ...request };
      const debugInfo: ConversionDebugInfo = {
        conversionId,
        originalRequest: { ...request },
        routingInfo: { ...context.routingInfo },
        pipelineConfig: { ...context.pipelineConfig },
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
          transformer: 'RequestTransformer',
          version: '1.0.0',
          startTime: new Date().toISOString()
        }
      };

      // 步骤1: 模型字段转换
      const modelStep = await this.transformModelField(
        convertedRequest,
        context,
        conversionTrace
      );
      debugInfo.conversionTrace.push(modelStep);
      debugInfo.appliedRules.push(...modelStep.rules);

      // 步骤2: 参数字段转换
      const paramStep = await this.transformParameterFields(
        convertedRequest,
        context,
        conversionTrace
      );
      debugInfo.conversionTrace.push(paramStep);
      debugInfo.appliedRules.push(...paramStep.rules);

      // 步骤3: 元数据注入
      const metaStep = await this.injectMetadata(
        convertedRequest,
        context,
        conversionTrace
      );
      debugInfo.conversionTrace.push(metaStep);
      debugInfo.appliedRules.push(...metaStep.rules);

      // 步骤4: 验证转换结果
      const validationStep = await this.validateTransformedRequest(
        convertedRequest,
        context,
        conversionTrace
      );
      debugInfo.conversionTrace.push(validationStep);
      debugInfo.appliedRules.push(...validationStep.rules);

      // 计算指标
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      debugInfo.metrics = {
        totalSteps: conversionTrace.length,
        totalDuration: totalTime,
        averageStepTime: totalTime / conversionTrace.length,
        memoryUsage: process.memoryUsage ? process.memoryUsage().heapUsed : 0,
        ruleUsage: this.calculateRuleUsage(debugInfo.appliedRules)
      };

      return {
        convertedRequest,
        debugInfo,
        success: true
      };

    } catch (error) {
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      return {
        convertedRequest: request,
        debugInfo: {
          conversionId,
          originalRequest: { ...request },
          routingInfo: { ...context.routingInfo },
          pipelineConfig: { ...context.pipelineConfig },
          conversionTrace,
          appliedRules: [],
          metrics: {
            totalSteps: conversionTrace.length,
            totalDuration: totalTime,
            averageStepTime: totalTime / Math.max(conversionTrace.length, 1),
            memoryUsage: process.memoryUsage ? process.memoryUsage().heapUsed : 0,
            ruleUsage: {}
          },
          meta: {
            transformer: 'RequestTransformer',
            version: '1.0.0',
            startTime: new Date(startTime).toISOString(),
            error: error instanceof Error ? error.message : String(error)
          }
        },
        success: false,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  /**
   * 转换模型字段
   */
  private async transformModelField(
    request: OpenAIRequest,
    context: ConversionContext,
    trace: ConversionStep[]
  ): Promise<ConversionStep> {
    const startTime = Date.now();
    const originalValue = request.model;

    const rules = this.fieldMappingRules.getParameterMappings();
    const modelRule = rules.find(rule => rule.sourceField === 'model');

    if (modelRule && modelRule.transformer) {
      request.model = modelRule.transformer(originalValue, context);
    }

    const endTime = Date.now();

    return {
      step: 'model_field_transformation',
      description: 'Transform model field using mapping rules',
      input: { model: originalValue },
      output: { model: request.model },
      timestamp: new Date(),
      rules: modelRule ? ['model_mapping_rule'] : [],
      duration: endTime - startTime
    };
  }

  /**
   * 转换参数字段
   */
  private async transformParameterFields(
    request: OpenAIRequest,
    context: ConversionContext,
    trace: ConversionStep[]
  ): Promise<ConversionStep> {
    const startTime = Date.now();
    const inputState = { ...request };
    const appliedRules: string[] = [];

    const rules = this.fieldMappingRules.getParameterMappings();

    for (const rule of rules) {
      if (rule.sourceField === 'model') {
        continue; // 模型字段已在前面处理
      }

      const originalValue = (request as any)[rule.sourceField];
      if (originalValue !== undefined) {
        // 应用转换器
        if (rule.transformer) {
          (request as any)[rule.sourceField] = rule.transformer(originalValue, context);
        }

        // 应用验证器
        if (rule.validator) {
          const validation = rule.validator(originalValue, context);
          if (!validation.isValid) {
            console.warn(`Validation failed for field ${rule.sourceField}:`, validation.errors);
          }
        }

        appliedRules.push(`${rule.sourceField}_transformation`);
      } else if (rule.defaultValue !== undefined) {
        // 应用默认值
        (request as any)[rule.sourceField] = rule.defaultValue;
        appliedRules.push(`${rule.sourceField}_default_value`);
      }
    }

    const endTime = Date.now();

    return {
      step: 'parameter_field_transformation',
      description: 'Transform parameter fields using mapping rules',
      input: inputState,
      output: { ...request },
      timestamp: new Date(),
      rules: appliedRules,
      duration: endTime - startTime
    };
  }

  /**
   * 注入元数据
   */
  private async injectMetadata(
    request: OpenAIRequest,
    context: ConversionContext,
    trace: ConversionStep[]
  ): Promise<ConversionStep> {
    const startTime = Date.now();

    // 确保元数据对象存在
    if (!request._meta) {
      request._meta = {};
    }

    // 注入路由信息
    request._meta.routing = {
      route: context.routingInfo.route,
      providerId: context.routingInfo.providerId,
      modelId: context.routingInfo.modelId,
      keyId: context.routingInfo.keyId,
      provider: context.pipelineConfig.provider,
      modelConfig: context.pipelineConfig.model
    };

    // 注入转换信息
    request._meta.conversion = {
      convertedAt: new Date().toISOString(),
      converter: 'RequestTransformer',
      originalModel: context.originalRequest.model,
      targetModel: request.model
    };

    const endTime = Date.now();

    return {
      step: 'metadata_injection',
      description: 'Inject routing and conversion metadata',
      input: { meta: request._meta },
      output: { meta: request._meta },
      timestamp: new Date(),
      rules: ['metadata_injection'],
      duration: endTime - startTime
    };
  }

  /**
   * 验证转换后的请求
   */
  private async validateTransformedRequest(
    request: OpenAIRequest,
    context: ConversionContext,
    trace: ConversionStep[]
  ): Promise<ConversionStep> {
    const startTime = Date.now();
    const validationErrors: string[] = [];

    // 验证必需字段
    if (!request.model || typeof request.model !== 'string') {
      validationErrors.push('Model field is required and must be a string');
    }

    if (!request.messages || !Array.isArray(request.messages)) {
      validationErrors.push('Messages field is required and must be an array');
    }

    // 验证消息格式
    if (request.messages) {
      for (let i = 0; i < request.messages.length; i++) {
        const message = request.messages[i];
        if (!message.role || !message.content) {
          validationErrors.push(`Message at index ${i} is missing role or content`);
        }
      }
    }

    // 验证数值字段
    if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens <= 0)) {
      validationErrors.push('max_tokens must be a positive number');
    }

    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
      validationErrors.push('temperature must be between 0 and 2');
    }

    if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p <= 0 || request.top_p > 1)) {
      validationErrors.push('top_p must be between 0 and 1');
    }

    const endTime = Date.now();

    return {
      step: 'request_validation',
      description: 'Validate transformed request structure and values',
      input: { request: { ...request } },
      output: {
        isValid: validationErrors.length === 0,
        errors: validationErrors
      },
      timestamp: new Date(),
      rules: validationErrors.length === 0 ? ['validation_passed'] : ['validation_failed'],
      duration: endTime - startTime
    };
  }

  /**
   * 生成转换ID
   */
  private generateConversionId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 计算规则使用统计
   */
  private calculateRuleUsage(appliedRules: string[]): Record<string, number> {
    const usage: Record<string, number> = {};

    for (const rule of appliedRules) {
      usage[rule] = (usage[rule] || 0) + 1;
    }

    return usage;
  }

  /**
   * 批量转换请求
   */
  async transformBatch(
    requests: OpenAIRequest[],
    contexts: ConversionContext[]
  ): Promise<{
    results: ConversionResult[];
    summary: {
      total: number;
      successful: number;
      failed: number;
      averageTime: number;
    };
  }> {
    const results: ConversionResult[] = [];
    let totalTime = 0;

    for (let i = 0; i < requests.length; i++) {
      const startTime = Date.now();
      const result = await this.transformOpenAIRequest(requests[i], contexts[i]);
      const endTime = Date.now();

      totalTime += (endTime - startTime);
      results.push(result);
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    return {
      results,
      summary: {
        total: requests.length,
        successful,
        failed,
        averageTime: totalTime / requests.length
      }
    };
  }

  /**
   * 获取转换器统计信息
   */
  getStatistics(): {
    rules: any;
    uptime: number;
  } {
    return {
      rules: this.fieldMappingRules.getRuleStatistics(),
      uptime: process.uptime ? process.uptime() * 1000 : 0
    };
  }
}