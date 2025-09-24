/**
 * Pipeline Node-Level Dry-Run Framework
 *
 * 支持在流水线任意节点进行dry-run，实现"流水线断裂"式的节点输出验证
 * 每个节点都可以独立配置为dry-run模式，用于测试和调试
 */

import type {
  PipelineModule,
  PipelineRequest,
  PipelineResponse
} from '../interfaces/pipeline-interfaces.js';
import type { DryRunConfig, DryRunResponse } from '../../dry-run/dry-run-interface.js';

/**
 * 节点级Dry-Run配置
 */
export interface NodeDryRunConfig {
  /** 是否启用此节点的dry-run模式 */
  enabled: boolean;
  /** Dry-运行模式 */
  mode: 'output-validation' | 'full-analysis' | 'error-simulation';
  /** 输出验证规则 */
  validationRules?: OutputValidationRule[];
  /** 错误模拟配置 */
  errorSimulation?: ErrorSimulationConfig;
  /** 断点行为 */
  breakpointBehavior: 'continue' | 'pause' | 'terminate';
  /** 详细程度 */
  verbosity: 'minimal' | 'normal' | 'detailed';
}

/**
 * 输出验证规则
 */
export interface OutputValidationRule {
  /** 规则ID */
  id: string;
  /** 验证类型 */
  type: 'schema' | 'format' | 'value-range' | 'custom';
  /** 验证条件 */
  condition: any;
  /** 错误消息 */
  errorMessage: string;
  /** 严重级别 */
  severity: 'warning' | 'error' | 'critical';
}

/**
 * 错误模拟配置
 */
export interface ErrorSimulationConfig {
  /** 是否启用错误模拟 */
  enabled: boolean;
  /** 错误类型 */
  errorType: 'timeout' | 'network' | 'validation' | 'custom';
  /** 触发概率 (0-1) */
  probability: number;
  /** 自定义错误信息 */
  customError?: any;
}

/**
 * 节点Dry-Run上下文
 */
export interface NodeDryRunContext {
  /** 节点ID */
  nodeId: string;
  /** 节点类型 */
  nodeType: string;
  /** 执行阶段 */
  executionPhase: 'pre-process' | 'process' | 'post-process';
  /** 输入数据 */
  inputData: any;
  /** 上下文元数据 */
  metadata: Record<string, any>;
}

/**
 * 节点Dry-Run结果
 */
export interface NodeDryRunResult {
  /** 节点标识 */
  nodeId: string;
  /** 节点类型 */
  nodeType: string;
  /** 执行状态 */
  status: 'success' | 'warning' | 'error' | 'simulated-error';
  /** 输入数据快照 */
  inputData: any;
  /** 预期输出数据 */
  expectedOutput: any;
  /** 验证结果 */
  validationResults: ValidationResult[];
  /** 性能指标 */
  performanceMetrics: {
    estimatedTime: number;
    estimatedMemory: number;
    complexity: number;
  };
  /** 执行日志 */
  executionLog: LogEntry[];
  /** 错误信息 */
  error?: any;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 规则ID */
  ruleId: string;
  /** 是否通过 */
  passed: boolean;
  /** 错误消息 */
  message: string;
  /** 严重级别 */
  severity: 'warning' | 'error' | 'critical';
  /** 验证详情 */
  details?: any;
}

/**
 * 日志条目
 */
export interface LogEntry {
  /** 时间戳 */
  timestamp: number;
  /** 级别 */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 消息 */
  message: string;
  /** 数据 */
  data?: any;
}

/**
 * 流水线Dry-Run执行计划
 */
export interface PipelineDryRunPlan {
  /** 计划ID */
  planId: string;
  /** 流水线ID */
  pipelineId: string;
  /** 启用dry-run的节点 */
  dryRunNodes: string[];
  /** 执行顺序 */
  executionOrder: string[];
  /** 断点设置 */
  breakpoints: Breakpoint[];
  /** 预期执行路径 */
  expectedPath: ExecutionPathNode[];
}

/**
 * 断点设置
 */
export interface Breakpoint {
  /** 节点ID */
  nodeId: string;
  /** 断点类型 */
  type: 'pre-execution' | 'post-execution' | 'error';
  /** 条件 */
  condition?: any;
}

/**
 * 执行路径节点
 */
export interface ExecutionPathNode {
  /** 节点ID */
  nodeId: string;
  /** 节点类型 */
  nodeType: string;
  /** 预期状态 */
  expectedStatus: 'dry-run' | 'normal' | 'skipped';
  /** 依赖关系 */
  dependencies: string[];
}

/**
 * 流水线Dry-Run响应
 */
export interface PipelineDryRunResponse extends Omit<DryRunResponse, 'requestSummary'> {
  /** 请求摘要 */
  requestSummary: {
    id: string;
    type: 'pipeline-node-dry-run';
    timestamp: string;
    pipelineId: string;
    dryRunNodeCount: number;
  };
  /** 执行计划 */
  executionPlan: PipelineDryRunPlan;
  /** 节点结果 */
  nodeResults: Map<string, NodeDryRunResult>;
  /** 流水线分析 */
  pipelineAnalysis: {
    totalNodes: number;
    dryRunNodes: number;
    normalNodes: number;
    executionBreaks: string[];
    dataFlowValidation: boolean;
    estimatedTotalTime: number;
  };
  /** 断点状态 */
  breakpointStatus: {
    hitBreakpoints: string[];
    paused: boolean;
    terminationReason?: string;
  };
}

/**
 * 支持Dry-Run的PipelineModule接口扩展
 */
export interface DryRunPipelineModule extends PipelineModule {
  /** 节点级dry-run配置 */
  dryRunConfig?: NodeDryRunConfig;

  /**
   * 执行节点级dry-run
   */
  executeNodeDryRun(
    request: any,
    context: NodeDryRunContext
  ): Promise<NodeDryRunResult>;

  /**
   * 验证输出数据
   */
  validateOutput(
    output: any,
    rules: OutputValidationRule[]
  ): Promise<ValidationResult[]>;

  /**
   * 模拟错误
   */
  simulateError(config: ErrorSimulationConfig): Promise<any>;

  /**
   * 估算性能指标
   */
  estimatePerformance(input: any): Promise<{
    time: number;
    memory: number;
    complexity: number;
  }>;
}

/**
 * 流水线Dry-Run管理器
 */
export class PipelineDryRunManager {
  private nodeConfigs: Map<string, NodeDryRunConfig> = new Map();
  private executionPlans: Map<string, PipelineDryRunPlan> = new Map();
  private breakpointHandlers: Map<string, (result: NodeDryRunResult) => void> = new Map();

  /**
   * 配置节点dry-run
   */
  configureNodeDryRun(nodeId: string, config: NodeDryRunConfig): void {
    this.nodeConfigs.set(nodeId, config);
  }

  /**
   * 批量配置节点dry-run
   */
  configureNodesDryRun(configs: Record<string, NodeDryRunConfig>): void {
    Object.entries(configs).forEach(([nodeId, config]) => {
      this.configureNodeDryRun(nodeId, config);
    });
  }

  /**
   * 创建执行计划
   */
  createExecutionPlan(
    pipelineId: string,
    nodes: string[],
    executionOrder: string[]
  ): PipelineDryRunPlan {
    const dryRunNodes = nodes.filter(nodeId =>
      this.nodeConfigs.get(nodeId)?.enabled
    );

    const breakpoints = dryRunNodes.map(nodeId => ({
      nodeId,
      type: 'post-execution' as const,
      condition: this.nodeConfigs.get(nodeId)?.breakpointBehavior === 'pause'
    }));

    const plan: PipelineDryRunPlan = {
      planId: `plan_${pipelineId}_${Date.now()}`,
      pipelineId,
      dryRunNodes,
      executionOrder,
      breakpoints,
      expectedPath: executionOrder.map(nodeId => ({
        nodeId,
        nodeType: 'unknown', // 将在执行时确定
        expectedStatus: dryRunNodes.includes(nodeId) ? 'dry-run' : 'normal',
        dependencies: executionOrder.slice(0, executionOrder.indexOf(nodeId))
      }))
    };

    this.executionPlans.set(pipelineId, plan);
    return plan;
  }

  /**
   * 执行节点dry-run
   */
  async executeNodeDryRun(
    module: DryRunPipelineModule,
    request: any,
    nodeId: string,
    context: Partial<NodeDryRunContext> = {}
  ): Promise<NodeDryRunResult> {
    const config = this.nodeConfigs.get(nodeId);
    if (!config?.enabled) {
      throw new Error(`Dry-run not enabled for node: ${nodeId}`);
    }

    const nodeContext: NodeDryRunContext = {
      nodeId,
      nodeType: module.type,
      executionPhase: 'process',
      inputData: request,
      metadata: {},
      ...context
    };

    // 根据模式执行不同的dry-run逻辑
    switch (config.mode) {
      case 'output-validation':
        return this.executeOutputValidation(module, request, nodeContext, config);

      case 'full-analysis':
        return this.executeFullAnalysis(module, request, nodeContext, config);

      case 'error-simulation':
        return this.executeErrorSimulation(module, request, nodeContext, config);

      default:
        throw new Error(`Unknown dry-run mode: ${config.mode}`);
    }
  }

  /**
   * 执行输出验证模式
   */
  private async executeOutputValidation(
    module: DryRunPipelineModule,
    request: any,
    context: NodeDryRunContext,
    config: NodeDryRunConfig
  ): Promise<NodeDryRunResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];

    try {
      // 模拟节点处理，生成预期输出
      const expectedOutput = await this.simulateNodeOutput(module, request, context);

      // 执行验证
      const validationResults = config.validationRules
        ? await module.validateOutput(expectedOutput, config.validationRules)
        : [];

      // 估算性能
      const performance = await module.estimatePerformance(request);

      const result: NodeDryRunResult = {
        nodeId: context.nodeId,
        nodeType: context.nodeType,
        status: validationResults.some(r => r.severity === 'error') ? 'error' :
                validationResults.some(r => r.severity === 'warning') ? 'warning' : 'success',
        inputData: request,
        expectedOutput,
        validationResults,
        performanceMetrics: {
          estimatedTime: performance.time,
          estimatedMemory: performance.memory,
          complexity: performance.complexity
        },
        executionLog: logs
      };

      // 处理断点
      await this.handleBreakpoint(context.nodeId, result);

      return result;

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logs.push({
        timestamp: Date.now(),
        level: 'error',
        message: 'Output validation failed',
        data: { error: msg }
      });

      return {
        nodeId: context.nodeId,
        nodeType: context.nodeType,
        status: 'error',
        inputData: request,
        expectedOutput: null,
        validationResults: [],
        performanceMetrics: { estimatedTime: 0, estimatedMemory: 0, complexity: 0 },
        executionLog: logs,
        error
      };
    }
  }

  /**
   * 执行完整分析模式
   */
  private async executeFullAnalysis(
    module: DryRunPipelineModule,
    request: any,
    context: NodeDryRunContext,
    config: NodeDryRunConfig
  ): Promise<NodeDryRunResult> {
    // 执行完整的节点dry-run分析
    return module.executeNodeDryRun(request, context);
  }

  /**
   * 执行错误模拟模式
   */
  private async executeErrorSimulation(
    module: DryRunPipelineModule,
    request: any,
    context: NodeDryRunContext,
    config: NodeDryRunConfig
  ): Promise<NodeDryRunResult> {
    const errorConfig = config.errorSimulation;
    if (!errorConfig?.enabled) {
      // 如果没有启用错误模拟，执行正常的输出验证
      return this.executeOutputValidation(module, request, context, config);
    }

    // 根据概率决定是否模拟错误
    const shouldSimulate = Math.random() < errorConfig.probability;
    if (!shouldSimulate) {
      return this.executeOutputValidation(module, request, context, config);
    }

    // 模拟错误
    const simulatedError = await module.simulateError(errorConfig);

    return {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      status: 'simulated-error',
      inputData: request,
      expectedOutput: null,
      validationResults: [],
      performanceMetrics: { estimatedTime: 0, estimatedMemory: 0, complexity: 0 },
      executionLog: [{
        timestamp: Date.now(),
        level: 'info',
        message: `Simulated ${errorConfig.errorType} error`,
        data: { errorConfig, simulatedError }
      }],
      error: simulatedError
    };
  }

  /**
   * 模拟节点输出
   */
  private async simulateNodeOutput(
    module: DryRunPipelineModule,
    request: any,
    context: NodeDryRunContext
  ): Promise<any> {
    // 这里可以调用模块的dry-run方法来生成预期输出
    // 如果模块没有实现dry-run，则基于输入数据生成模拟输出
    try {
      if ('executeNodeDryRun' in module) {
        const result = await module.executeNodeDryRun(request, context);
        return result.expectedOutput;
      }

      // 基础模拟逻辑
      return this.generateMockOutput(request, context.nodeType);
    } catch (error) {
      // 如果无法生成预期输出，返回输入的副本
      return JSON.parse(JSON.stringify(request));
    }
  }

  /**
   * 生成模拟输出
   */
  private generateMockOutput(input: any, nodeType: string): any {
    // 根据节点类型生成不同的模拟输出
    switch (nodeType) {
      case 'llm-switch':
        return {
          ...input,
          _metadata: {
            switchType: 'mock',
            timestamp: Date.now(),
            routing: 'default'
          }
        };

      case 'compatibility':
        return {
          ...input,
          _transformed: true,
          _metadata: {
            compatibility: 'mock',
            timestamp: Date.now()
          }
        };

      case 'provider':
        return {
          id: 'mock-response',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Mock response from dry-run mode'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20
          }
        };

      default:
        return input;
    }
  }

  /**
   * 处理断点
   */
  private async handleBreakpoint(nodeId: string, result: NodeDryRunResult): Promise<void> {
    const handler = this.breakpointHandlers.get(nodeId);
    if (handler) {
      handler(result);
    }
  }

  /**
   * 设置断点处理器
   */
  setBreakpointHandler(nodeId: string, handler: (result: NodeDryRunResult) => void): void {
    this.breakpointHandlers.set(nodeId, handler);
  }

  /**
   * 获取节点配置
   */
  getNodeConfig(nodeId: string): NodeDryRunConfig | undefined {
    return this.nodeConfigs.get(nodeId);
  }

  /**
   * 获取执行计划
   */
  getExecutionPlan(pipelineId: string): PipelineDryRunPlan | undefined {
    return this.executionPlans.get(pipelineId);
  }

  /**
   * 清理配置
   */
  clear(): void {
    this.nodeConfigs.clear();
    this.executionPlans.clear();
    this.breakpointHandlers.clear();
  }
}

/**
 * 导出单例实例
 */
export const pipelineDryRunManager = new PipelineDryRunManager();
