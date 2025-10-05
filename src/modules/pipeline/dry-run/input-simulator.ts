/**
 * Pipeline Dry-Run Input Simulator
 *
 * 解决所有节点dry-run时的输入数据问题
 * 通过智能输入模拟和上下文传播，实现完整的全流水线dry-run
 */

import type { PipelineModule } from '../interfaces/pipeline-interfaces.js';
import type { NodeDryRunContext } from './pipeline-dry-run-framework.js';

/**
 * 输入模拟策略
 */
export interface InputSimulationStrategy {
  /** 策略名称 */
  name: string;
  /** 策略描述 */
  description: string;
  /** 适用节点类型 */
  applicableNodeTypes: string[];
  /** 模拟优先级 (数字越大优先级越高) */
  priority: number;
}

/**
 * 模拟数据质量等级
 */
export type MockDataQuality = 'low' | 'medium' | 'high';

/**
 * 输入模拟配置
 */
export interface InputSimulationConfig {
  /** 是否启用输入模拟 */
  enabled: boolean;
  /** 主要策略 */
  primaryStrategy: string;
  /** 备用策略 */
  fallbackStrategies: string[];
  /** 数据质量要求 */
  qualityRequirement: MockDataQuality;
  /** 是否使用历史数据 */
  useHistoricalData: boolean;
  /** 是否启用智能推断 */
  enableSmartInference: boolean;
}

/**
 * 模拟输入结果
 */
export interface SimulatedInput {
  /** 数据源 */
  source: 'original-request' | 'historical-data' | 'schema-inference' | 'ai-generation' | 'rule-based';
  /** 模拟的数据 */
  data: any;
  /** 质量评分 (0-1) */
  quality: number;
  /** 置信度 (0-1) */
  confidence: number;
  /** 使用的策略 */
  strategy: string;
  /** 元数据 */
  metadata: {
    generationTime: number;
    rulesApplied: string[];
    inferenceSteps: string[];
  };
}

/**
 * 上下文传播数据
 */
export interface ContextPropagationData {
  /** 节点ID到输出数据的映射 */
  nodeOutputs: Map<string, any>;
  /** 数据流路径 */
  dataFlowPath: string[];
  /** 转换历史 */
  transformationHistory: Array<{
    nodeId: string;
    inputType: string;
    outputType: string;
    transformation: string;
  }>;
  /** 执行上下文 */
  executionContext: {
    requestId: string;
    pipelineId: string;
    originalRequest: any;
  };
}

/**
 * 输入模拟器
 */
export class InputSimulator {
  private strategies: Map<string, (input: any, context: NodeDryRunContext) => Promise<SimulatedInput>> = new Map();
  private historicalData: Map<string, unknown[]> = new Map();
  private quality: MockDataQuality = 'medium';

  constructor() {
    this.initializeStrategies();
  }

  /**
   * 初始化模拟策略
   */
  private initializeStrategies() {
    // 策略1: 基于历史数据的模拟
    this.strategies.set('historical-data', async (input, context) => {
      const historicalData = this.getHistoricalData(context.nodeType);
      if (historicalData.length > 0) {
        const matchedData = this.findBestMatch(input, historicalData);
        return {
          source: 'historical-data',
          data: matchedData,
          quality: 0.9,
          confidence: 0.8,
          strategy: 'historical-data',
          metadata: {
            generationTime: Date.now(),
            rulesApplied: ['historical-match'],
            inferenceSteps: ['data-retrieval', 'similarity-matching']
          }
        };
      }
      throw new Error('No historical data available');
    });

    // 策略2: 基于Schema的推断
    this.strategies.set('schema-inference', async (input, context) => {
      const schema = this.getNodeSchema(context.nodeType);
      const inferredData = this.inferFromSchema(schema, input);
      return {
        source: 'schema-inference',
        data: inferredData,
        quality: 0.7,
        confidence: 0.6,
        strategy: 'schema-inference',
        metadata: {
          generationTime: Date.now(),
          rulesApplied: ['schema-validation', 'type-inference'],
          inferenceSteps: ['schema-analysis', 'data-generation']
        }
      };
    });

    // 策略3: 基于规则的生成
    this.strategies.set('rule-based', async (input, context) => {
      const generatedData = this.generateByRules(context.nodeType, input);
      return {
        source: 'rule-based',
        data: generatedData,
        quality: 0.6,
        confidence: 0.7,
        strategy: 'rule-based',
        metadata: {
          generationTime: Date.now(),
          rulesApplied: ['template-matching', 'pattern-generation'],
          inferenceSteps: ['rule-application', 'data-construction']
        }
      };
    });

    // 策略4: AI增强生成
    this.strategies.set('ai-generation', async (input, context) => {
      const generatedData = await this.generateWithAI(context.nodeType, input);
      return {
        source: 'ai-generation',
        data: generatedData,
        quality: 0.8,
        confidence: 0.9,
        strategy: 'ai-generation',
        metadata: {
          generationTime: Date.now(),
          rulesApplied: ['ai-inference', 'context-awareness'],
          inferenceSteps: ['ai-analysis', 'smart-generation']
        }
      };
    });

    // 策略5: 原始请求传播
    this.strategies.set('request-propagation', async (input, context) => {
      const propagatedData = this.propagateOriginalRequest(input, context.nodeType);
      return {
        source: 'original-request',
        data: propagatedData,
        quality: 0.5,
        confidence: 0.4,
        strategy: 'request-propagation',
        metadata: {
          generationTime: Date.now(),
          rulesApplied: ['field-mapping', 'structure-preservation'],
          inferenceSteps: ['request-analysis', 'field-transformation']
        }
      };
    });
  }

  /**
   * 模拟节点输入
   */
  async simulateInput(
    originalRequest: any,
    nodeId: string,
    nodeType: string,
    contextData: ContextPropagationData,
    config: InputSimulationConfig
  ): Promise<SimulatedInput> {
    const nodeContext: NodeDryRunContext = {
      nodeId,
      nodeType,
      executionPhase: 'process',
      inputData: originalRequest,
      metadata: {
        ...contextData.executionContext,
        contextData
      }
    };

    // 尝试主要策略
    try {
      const primaryStrategy = this.strategies.get(config.primaryStrategy);
      if (primaryStrategy) {
        const result = await primaryStrategy(originalRequest, nodeContext);
        if (this.meetsQualityRequirement(result, config.qualityRequirement)) {
          return result;
        }
      }
    } catch (error) {
      console.log(`Primary strategy failed for ${nodeId}:`, error instanceof Error ? error.message : String(error));
    }

    // 尝试备用策略
    for (const strategyName of config.fallbackStrategies) {
      try {
        const fallbackStrategy = this.strategies.get(strategyName);
        if (fallbackStrategy) {
          const result = await fallbackStrategy(originalRequest, nodeContext);
          if (this.meetsQualityRequirement(result, config.qualityRequirement)) {
            return result;
          }
        }
      } catch (error) {
        console.log(`Fallback strategy ${strategyName} failed for ${nodeId}:`, error instanceof Error ? error.message : String(error));
      }
    }

    // 如果所有策略都失败，使用最低质量的兜底方案
    return this.createFallbackInput(originalRequest, nodeType);
  }

  /**
   * 创建完整的流水线dry-run上下文
   */
  async createPipelineDryRunContext(
    originalRequest: any,
    nodeOrder: Array<{id: string, type: string}>,
    config: InputSimulationConfig
  ): Promise<ContextPropagationData> {
    const contextData: ContextPropagationData = {
      nodeOutputs: new Map(),
      dataFlowPath: [],
      transformationHistory: [],
      executionContext: {
        requestId: `dry-run-${Date.now()}`,
        pipelineId: 'unknown',
        originalRequest
      }
    };

    // 为每个节点生成模拟输入
    for (let i = 0; i < nodeOrder.length; i++) {
      const node = nodeOrder[i];

      // 获取前一个节点的输出，如果没有则使用原始请求
      let previousOutput = originalRequest;
      if (i > 0) {
        const previousNode = nodeOrder[i - 1];
        previousOutput = contextData.nodeOutputs.get(previousNode.id) || previousOutput;
      }

      // 模拟当前节点的输入
      const simulatedInput = await this.simulateInput(
        previousOutput,
        node.id,
        node.type,
        contextData,
        config
      );

      // 生成当前节点的预期输出
      const expectedOutput = await this.generateExpectedOutput(node.type, simulatedInput.data);

      // 记录到上下文中
      contextData.nodeOutputs.set(node.id, expectedOutput);
      contextData.dataFlowPath.push(node.id);
      contextData.transformationHistory.push({
        nodeId: node.id,
        inputType: this.getDataType(simulatedInput.data),
        outputType: this.getDataType(expectedOutput),
        transformation: 'dry-run-simulation'
      });
    }

    return contextData;
  }

  /**
   * 获取节点schema
   */
  private getNodeSchema(nodeType: string): any {
    const schemas: Record<string, any> = {
      'llm-switch': {
        input: ['model', 'messages', 'temperature', 'max_tokens'],
        output: ['_metadata', 'model', 'messages'],
        required: ['model', 'messages']
      },
      'compatibility': {
        input: ['_metadata', 'model', 'messages'],
        output: ['_transformed', 'model', 'messages'],
        required: ['model', 'messages']
      },
      'provider': {
        input: ['model', 'messages'],
        output: ['id', 'object', 'choices', 'usage'],
        required: ['model', 'messages']
      }
    };

    return schemas[nodeType] || { input: [], output: [], required: [] };
  }

  /**
   * 基于schema推断数据
   */
  private inferFromSchema(schema: any, input: any): any {
    const output: any = {};

    // 复制输入字段
    Object.keys(input).forEach(key => {
      if (schema.output.includes(key)) {
        output[key] = JSON.parse(JSON.stringify(input));
      }
    });

    // 添加必需的输出字段
    schema.required.forEach((field: string) => {
      if (!output[field]) {
        output[field] = this.generateMockValue(field, schema);
      }
    });

    // 添加特定节点类型的字段
    if (schema.output.includes('_metadata')) {
      output._metadata = {
        timestamp: Date.now(),
        simulated: true,
        quality: 'medium'
      };
    }

    if (schema.output.includes('id')) {
      output.id = `simulated-${Date.now()}`;
    }

    if (schema.output.includes('object')) {
      output.object = 'chat.completion';
    }

    return output;
  }

  /**
   * 基于规则生成数据
   */
  private generateByRules(nodeType: string, input: any): any {
    const templates: Record<string, any> = {
      'llm-switch': {
        ...input,
        _metadata: {
          switchType: 'llmswitch-openai-openai',
          timestamp: Date.now(),
          originalProtocol: 'openai',
          targetProtocol: 'openai',
          routing: 'default'
        }
      },
      'compatibility': {
        ...input,
        _transformed: true,
        _metadata: {
          compatibility: 'mock',
          timestamp: Date.now()
        }
      },
      'provider': {
        id: `chatcmpl-${  Math.random().toString(36).substr(2, 9)}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'This is a simulated response from dry-run mode.'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        }
      }
    };

    return templates[nodeType] || input;
  }

  /**
   * 使用AI生成数据（模拟）
   */
  private async generateWithAI(nodeType: string, input: any): Promise<any> {
    // 这里可以集成真实的AI服务，现在使用模拟
    await new Promise(resolve => setTimeout(resolve, 100)); // 模拟AI调用延迟

    const baseData = this.generateByRules(nodeType, input);
    return {
      ...baseData,
      _metadata: {
        ...baseData._metadata,
        generatedBy: 'ai-simulation',
        quality: 'high',
        confidence: 0.9
      }
    };
  }

  /**
   * 传播原始请求
   */
  private propagateOriginalRequest(input: any, nodeType: string): any {
    return {
      ...input,
      _simulated: true,
      _nodeType: nodeType,
      _timestamp: Date.now()
    };
  }

  /**
   * 生成预期输出
   */
  private async generateExpectedOutput(nodeType: string, input: any): Promise<any> {
    // 使用rule-based策略生成预期输出
    return this.generateByRules(nodeType, input);
  }

  /**
   * 获取历史数据
   */
  private getHistoricalData(nodeType: string): any[] {
    return this.historicalData.get(nodeType) || [];
  }

  /**
   * 查找最佳匹配
   */
  private findBestMatch(input: any, historicalData: any[]): any {
    // 简单的匹配逻辑，实际可以使用更复杂的相似度算法
    return historicalData[0] || input;
  }

  /**
   * 生成模拟值
   */
  private generateMockValue(field: string, schema: any): any {
    const mockValues: Record<string, any> = {
      'timestamp': Date.now(),
      'id': `mock-${Date.now()}`,
      'model': 'mock-model',
      'temperature': 0.7,
      'max_tokens': 1000,
      'content': 'Mock content from dry-run simulation'
    };

    return mockValues[field] || 'mock-value';
  }

  /**
   * 获取数据类型
   */
  private getDataType(data: any): string {
    if (Array.isArray(data)) {return 'array';}
    if (typeof data === 'object' && data !== null) {return 'object';}
    return typeof data;
  }

  /**
   * 检查质量要求
   */
  private meetsQualityRequirement(result: SimulatedInput, requirement: MockDataQuality): boolean {
    const thresholds: Record<MockDataQuality, number> = {
      'low': 0.3,
      'medium': 0.6,
      'high': 0.8
    };

    return result.quality >= thresholds[requirement];
  }

  /**
   * 创建兜底输入
   */
  private createFallbackInput(input: any, nodeType: string): SimulatedInput {
    return {
      source: 'rule-based',
      data: this.generateByRules(nodeType, input),
      quality: 0.3,
      confidence: 0.2,
      strategy: 'fallback',
      metadata: {
        generationTime: Date.now(),
        rulesApplied: ['fallback-generation'],
        inferenceSteps: ['emergency-fallback']
      }
    };
  }

  /**
   * 添加历史数据
   */
  addHistoricalData(nodeType: string, data: any): void {
    if (!this.historicalData.has(nodeType)) {
      this.historicalData.set(nodeType, []);
    }
    this.historicalData.get(nodeType)!.push({
      ...data,
      timestamp: Date.now()
    });

    // 保持历史数据大小限制
    const maxSize = 100;
    const nodeData = this.historicalData.get(nodeType)!;
    if (nodeData.length > maxSize) {
      nodeData.splice(0, nodeData.length - maxSize);
    }
  }

  /**
   * 设置质量要求
   */
  setQuality(quality: MockDataQuality): void {
    this.quality = quality;
  }

  /**
   * 获取可用策略
   */
  getAvailableStrategies(): InputSimulationStrategy[] {
    return [
      { name: 'historical-data', description: '基于历史数据的模拟', applicableNodeTypes: ['*'], priority: 5 },
      { name: 'schema-inference', description: '基于Schema的推断', applicableNodeTypes: ['*'], priority: 4 },
      { name: 'ai-generation', description: 'AI增强生成', applicableNodeTypes: ['*'], priority: 3 },
      { name: 'rule-based', description: '基于规则的生成', applicableNodeTypes: ['*'], priority: 2 },
      { name: 'request-propagation', description: '原始请求传播', applicableNodeTypes: ['*'], priority: 1 }
    ];
  }

  /**
   * 清理历史数据
   */
  clearHistoricalData(): void {
    this.historicalData.clear();
  }
}

/**
 * 导出单例实例
 */
export const inputSimulator = new InputSimulator();
