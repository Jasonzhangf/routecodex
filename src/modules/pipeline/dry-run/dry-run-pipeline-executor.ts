/**
 * Dry-Run Pipeline Executor
 *
 * 支持在流水线执行过程中在任意节点进行dry-run，实现"流水线断裂"调试
 * 可以配置特定节点进行dry-run，其他节点正常执行
 * 支持全节点dry-run模式，通过智能输入模拟解决数据流问题
 */

import type {
  PipelineModule,
  PipelineRequest,
  PipelineResponse
} from '../interfaces/pipeline-interfaces.js';
import type {
  DryRunPipelineModule,
  NodeDryRunConfig,
  NodeDryRunResult,
  PipelineDryRunResponse
} from './pipeline-dry-run-framework.js';
import { pipelineDryRunManager } from './pipeline-dry-run-framework.js';
import { inputSimulator, type InputSimulationConfig, type ContextPropagationData } from './input-simulator.js';

/**
 * 流水线执行节点信息
 */
export interface PipelineNodeInfo {
  /** 节点ID */
  id: string;
  /** 节点类型 */
  type: string;
  /** 节点模块 */
  module: PipelineModule;
  /** 是否为dry-run节点 */
  isDryRun: boolean;
  /** 节点配置 */
  config?: NodeDryRunConfig;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  /** 请求ID */
  requestId: string;
  /** 流水线ID */
  pipelineId: string;
  /** 执行模式 */
  mode: 'normal' | 'dry-run' | 'mixed';
  /** 当前阶段 */
  currentPhase: 'initialization' | 'execution' | 'finalization';
  /** 执行数据 */
  executionData: Map<string, any>;
  /** 干运行结果 */
  dryRunResults: Map<string, NodeDryRunResult>;
  /** 元数据 */
  metadata: {
    /** 开始时间 */
    startTime: number;
    /** 干运行节点列表 */
    dryRunNodes: string[];
    /** 是否所有节点都是dry-run */
    isAllNodesDryRun: boolean;
    /** 模拟上下文数据 */
    simulatedContext?: ContextPropagationData | null;
  };
}

/**
 * 断点触发事件
 */
export interface BreakpointEvent {
  /** 事件类型 */
  type: 'breakpoint-hit' | 'node-completed' | 'error-occurred';
  /** 节点ID */
  nodeId: string;
  /** 时间戳 */
  timestamp: number;
  /** 数据 */
  data: any;
}

/**
 * Dry-Run流水线执行器
 */
export class DryRunPipelineExecutor {
  private pipelineNodes: Map<string, PipelineNodeInfo> = new Map();
  private executionOrder: string[] = [];
  private eventHandlers: Map<string, ((event: BreakpointEvent) => void)[]> = new Map();
  private activeExecutions: Map<string, ExecutionContext> = new Map();

  /**
   * 注册流水线节点
   */
  registerNode(nodeInfo: PipelineNodeInfo): void {
    this.pipelineNodes.set(nodeInfo.id, nodeInfo);
    if (!this.executionOrder.includes(nodeInfo.id)) {
      this.executionOrder.push(nodeInfo.id);
    }

    // 如果是dry-run节点，配置dry-run管理器
    if (nodeInfo.isDryRun && nodeInfo.config) {
      pipelineDryRunManager.configureNodeDryRun(nodeInfo.id, nodeInfo.config);
    }
  }

  /**
   * 批量注册节点
   */
  registerNodes(nodes: PipelineNodeInfo[]): void {
    nodes.forEach(node => this.registerNode(node));
  }

  /**
   * 设置执行顺序
   */
  setExecutionOrder(order: string[]): void {
    this.executionOrder = [...order];
  }

  /**
   * 添加事件处理器
   */
  addEventHandler(eventType: string, handler: (event: BreakpointEvent) => void): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)!.push(handler);
  }

  /**
   * 执行流水线
   */
  async executePipeline(
    request: PipelineRequest,
    pipelineId: string,
    mode: 'normal' | 'dry-run' | 'mixed' = 'normal'
  ): Promise<PipelineResponse | PipelineDryRunResponse> {
    // 创建执行上下文
    const dryRunNodes = Array.from(this.pipelineNodes.values()).filter(n => n.isDryRun);
    const isAllNodesDryRun = dryRunNodes.length === this.pipelineNodes.size;

    const context: ExecutionContext = {
      requestId: request.route.requestId,
      pipelineId,
      mode,
      currentPhase: 'initialization',
      executionData: new Map(),
      dryRunResults: new Map(),
      metadata: {
        startTime: Date.now(),
        dryRunNodes: dryRunNodes.map(n => n.id),
        isAllNodesDryRun
      }
    };

    this.activeExecutions.set(context.requestId, context);

    try {
      // 如果是所有节点dry-run，使用输入模拟器创建完整的上下文
      let simulatedContext: ContextPropagationData | null = null;
      if (isAllNodesDryRun && mode === 'dry-run') {
        const nodeOrder = this.executionOrder.map(nodeId => ({
          id: nodeId,
          type: this.pipelineNodes.get(nodeId)?.type || 'unknown'
        }));

        const inputConfig: InputSimulationConfig = {
          enabled: true,
          primaryStrategy: 'historical-data',
          fallbackStrategies: ['schema-inference', 'rule-based', 'ai-generation', 'request-propagation'],
          qualityRequirement: 'medium',
          useHistoricalData: true,
          enableSmartInference: true
        };

        simulatedContext = await inputSimulator.createPipelineDryRunContext(
          request.data,
          nodeOrder,
          inputConfig
        );

        context.metadata.simulatedContext = simulatedContext;
      }

      // 创建执行计划
      const plan = pipelineDryRunManager.createExecutionPlan(
        pipelineId,
        Array.from(this.pipelineNodes.keys()),
        this.executionOrder
      );

      context.currentPhase = 'execution';

      // 执行流水线节点
      for (const nodeId of this.executionOrder) {
        const nodeInfo = this.pipelineNodes.get(nodeId);
        if (!nodeInfo) {
          throw new Error(`Node not found: ${nodeId}`);
        }

        // 执行节点
        const result = await this.executeNode(nodeInfo, request, context, simulatedContext);

        // 更新执行数据
        context.executionData.set(nodeId, result);

        // 如果是dry-run结果，记录到dry-run结果中
        if (nodeInfo.isDryRun && this.isDryRunResult(result)) {
          context.dryRunResults.set(nodeId, result);
        }

        // 触发节点完成事件
        this.emitEvent({
          type: 'node-completed',
          nodeId,
          timestamp: Date.now(),
          data: { result, nodeType: nodeInfo.type }
        });

        // 检查是否需要暂停或终止
        if (await this.shouldPauseExecution(nodeId, context)) {
          break;
        }
      }

      context.currentPhase = 'finalization';

      // 根据模式返回不同类型的响应
      if (mode === 'normal') {
        // 返回正常的流水线响应
        const finalNode = this.executionOrder[this.executionOrder.length - 1];
        const finalResult = context.executionData.get(finalNode);
        return this.createPipelineResponse(finalResult, context);
      } else {
        // 返回dry-run响应
        return this.createDryRunResponse(context, plan);
      }

    } catch (error) {
      // 触发错误事件
      this.emitEvent({
        type: 'error-occurred',
        nodeId: 'unknown',
        timestamp: Date.now(),
        data: { error: error instanceof Error ? error.message : String(error) }
      });

      throw error;
    } finally {
      this.activeExecutions.delete(context.requestId);
    }
  }

  /**
   * 执行单个节点
   */
  private async executeNode(
    nodeInfo: PipelineNodeInfo,
    request: any,
    context: ExecutionContext,
    simulatedContext: ContextPropagationData | null = null
  ): Promise<any> {
    if (nodeInfo.isDryRun) {
      // 执行dry-run
      return await this.executeDryRunNode(nodeInfo, request, context, simulatedContext);
    } else {
      // 正常执行
      return await this.executeNormalNode(nodeInfo, request, context, simulatedContext);
    }
  }

  /**
   * 执行dry-run节点
   */
  private async executeDryRunNode(
    nodeInfo: PipelineNodeInfo,
    request: any,
    context: ExecutionContext,
    simulatedContext: ContextPropagationData | null = null
  ): Promise<NodeDryRunResult> {
    const dryRunModule = nodeInfo.module as DryRunPipelineModule;

    // 获取前一个节点的输出作为当前节点的输入
    const nodeIndex = this.executionOrder.indexOf(nodeInfo.id);
    let inputData = request;

    if (nodeIndex > 0) {
      const previousNodeId = this.executionOrder[nodeIndex - 1];
      const previousResult = context.executionData.get(previousNodeId);

      if (previousResult && this.isDryRunResult(previousResult)) {
        inputData = previousResult.expectedOutput;
      } else {
        inputData = previousResult;
      }
    }

    // 如果是所有节点dry-run模式且有模拟上下文，使用模拟的输入
    if (context.metadata.isAllNodesDryRun && simulatedContext) {
      const simulatedInput = simulatedContext.nodeOutputs.get(nodeInfo.id);
      if (simulatedInput) {
        inputData = simulatedInput;

        // 记录使用了模拟输入
        console.log(`[Dry-Run] Node ${nodeInfo.id} using simulated input from context`);
      }
    }

    try {
      const result = await pipelineDryRunManager.executeNodeDryRun(
        dryRunModule,
        inputData,
        nodeInfo.id,
        {
          metadata: {
            executionId: context.requestId,
            pipelineId: context.pipelineId,
            nodeIndex,
            isSimulated: context.metadata.isAllNodesDryRun,
            simulatedInput: context.metadata.isAllNodesDryRun ? inputData : null
          }
        }
      );

      // 记录断点事件
      this.emitEvent({
        type: 'breakpoint-hit',
        nodeId: nodeInfo.id,
        timestamp: Date.now(),
        data: { dryRunResult: result }
      });

      return result;

    } catch (error) {
      return {
        nodeId: nodeInfo.id,
        nodeType: nodeInfo.type,
        status: 'error',
        inputData,
        expectedOutput: null,
        validationResults: [],
        performanceMetrics: { estimatedTime: 0, estimatedMemory: 0, complexity: 0 },
        executionLog: [{
          timestamp: Date.now(),
          level: 'error',
          message: 'Dry-run execution failed',
          data: { error: error instanceof Error ? error.message : String(error) }
        }],
        error
      };
    }
  }

  /**
   * 执行正常节点
   */
  private async executeNormalNode(
    nodeInfo: PipelineNodeInfo,
    request: any,
    context: ExecutionContext,
    simulatedContext: ContextPropagationData | null = null
  ): Promise<any> {
    // 获取前一个节点的输出作为当前节点的输入
    const nodeIndex = this.executionOrder.indexOf(nodeInfo.id);
    let inputData = request;

    if (nodeIndex > 0) {
      const previousNodeId = this.executionOrder[nodeIndex - 1];
      const previousResult = context.executionData.get(previousNodeId);

      // 如果前一个节点是dry-run节点，使用其预期输出
      if (previousResult && this.isDryRunResult(previousResult)) {
        inputData = previousResult.expectedOutput;
      } else {
        inputData = previousResult;
      }
    }

    // 如果是所有节点dry-run模式且有模拟上下文，为正常节点也提供模拟输入（混合模式）
    if (context.metadata.isAllNodesDryRun && simulatedContext && context.mode === 'mixed') {
      const simulatedInput = simulatedContext.nodeOutputs.get(nodeInfo.id);
      if (simulatedInput) {
        inputData = simulatedInput;
        console.log(`[Mixed-Mode] Node ${nodeInfo.id} using simulated input from context`);
      }
    }

    // 正常执行节点
    const result = await nodeInfo.module.processIncoming(inputData);
    return result;
  }

  /**
   * 检查是否需要暂停执行
   */
  private async shouldPauseExecution(nodeId: string, context: ExecutionContext): Promise<boolean> {
    const nodeConfig = pipelineDryRunManager.getNodeConfig(nodeId);
    if (!nodeConfig) {
      return false;
    }

    // 检查断点行为
    switch (nodeConfig.breakpointBehavior) {
      case 'pause':
        return true;
      case 'terminate':
        (context.metadata as any).terminationReason = `Terminated at node: ${nodeId}`;
        return true;
      case 'continue':
      default:
        return false;
    }
  }

  /**
   * 创建流水线响应
   */
  private createPipelineResponse(finalResult: any, context: ExecutionContext): PipelineResponse {
    return {
      data: finalResult,
      metadata: {
        pipelineId: context.pipelineId,
        processingTime: Date.now() - context.metadata.startTime,
        stages: [`executed ${context.executionData.size} nodes`],
        errors: []
      }
    };
  }

  /**
   * 创建dry-run响应
   */
  private createDryRunResponse(context: ExecutionContext, plan: any): PipelineDryRunResponse {
    const dryRunNodes = Array.from(context.dryRunResults.keys());
    const normalNodes = this.executionOrder.filter(id => !dryRunNodes.includes(id));

    // 执行情况与断点推断
    const executedNodes = Array.from(context.executionData.keys());
    const breakOccurred = executedNodes.length < this.executionOrder.length;
    const terminationReason = (context.metadata as any).terminationReason as string | undefined;
    const paused = breakOccurred && !terminationReason;

    // 命中断点的节点（依据节点配置的断点行为）
    const hitBreakpoints = executedNodes.filter(nodeId => {
      const cfg = pipelineDryRunManager.getNodeConfig(nodeId);
      return cfg && (cfg.breakpointBehavior === 'pause' || cfg.breakpointBehavior === 'terminate');
    });

    // 数据流校验：所有dry-run节点都应给出expectedOutput
    const dataFlowValidation = Array.from(context.dryRunResults.values())
      .every(r => typeof r !== 'undefined' && r !== null && typeof r.expectedOutput !== 'undefined');

    // 估算总执行时间：优先汇总节点估算时间，回退为总耗时
    const estimatedTotalTimeFromMetrics = Array.from(context.dryRunResults.values())
      .reduce((sum, r) => sum + (r.performanceMetrics?.estimatedTime || 0), 0);

    const isAllNodesDryRun = context.metadata.isAllNodesDryRun;
    const hasSimulatedContext = context.metadata.simulatedContext !== null;

    const response: PipelineDryRunResponse = {
      mode: 'dry-run',
      requestSummary: {
        id: context.requestId,
        type: 'pipeline-node-dry-run',
        timestamp: new Date().toISOString(),
        pipelineId: context.pipelineId,
        dryRunNodeCount: dryRunNodes.length
      },
      extendedSummary: {
        isAllNodesDryRun,
        hasSimulatedContext
      },
      routingDecision: {
        requestId: context.requestId,
        routeName: context.pipelineId,
        selectedTarget: {
          providerId: 'unknown',
          modelId: 'unknown',
          keyId: 'unknown',
          actualKey: 'unknown'
        },
        availableTargets: [],
        loadBalancerDecision: {
          algorithm: isAllNodesDryRun ? 'simulated-dry-run' : 'dry-run',
          weights: {},
          selectedWeight: 0,
          reasoning: isAllNodesDryRun
            ? 'All nodes dry-run execution with simulated input'
            : 'Pipeline dry-run execution'
        },
        timestamp: new Date().toISOString(),
        decisionTimeMs: 0
      },
      fieldConversion: {
        originalFields: [],
        convertedFields: [],
        fieldMappings: [],
        conversionTimeMs: 0,
        success: true,
        isSimulated: isAllNodesDryRun
      },
      protocolProcessing: {
        inputProtocol: 'unknown',
        outputProtocol: 'unknown',
        conversionSteps: [],
        processingTimeMs: 0,
        requiresConversion: false,
        simulationUsed: hasSimulatedContext
      },
      executionPlan: plan as any, // 使用完整的执行计划对象
      // 节点级dry-run结果映射
      nodeResults: context.dryRunResults,
      // 流水线整体分析
      pipelineAnalysis: {
        totalNodes: this.executionOrder.length,
        dryRunNodes: dryRunNodes.length,
        normalNodes: normalNodes.length,
        executionBreaks: breakOccurred ? [executedNodes[executedNodes.length - 1] || 'unknown'] : [],
        dataFlowValidation,
        estimatedTotalTime: estimatedTotalTimeFromMetrics || (Date.now() - context.metadata.startTime)
      },
      // 断点状态
      breakpointStatus: {
        hitBreakpoints,
        paused,
        terminationReason
      },
      loadBalancerDecision: undefined,
      performanceAnalysis: {
        currentLoad: 0,
        predictedResponseTime: 0,
        resourceUtilization: {},
        bottlenecks: [],
        simulationAccuracy: hasSimulatedContext ? 'high' : 'medium'
      },
      healthAnalysis: {
        overallHealth: isAllNodesDryRun ? 'simulated' : 'excellent' as const,
        targetHealthStatus: [],
        simulationHealth: hasSimulatedContext ? 'stable' : 'unknown'
      },
      recommendations: {
        strategy: isAllNodesDryRun
          ? 'All-nodes dry-run execution completed with simulated input'
          : 'Dry-run execution completed successfully',
        scaling: isAllNodesDryRun
          ? 'Full pipeline simulation with input propagation is working'
          : 'Node-level dry-run analysis is working',
        health: hasSimulatedContext
          ? 'Input simulation system functioning properly'
          : 'All dry-run nodes validated successfully'
      },
      totalDryRunTimeMs: Date.now() - context.metadata.startTime,
      simulationSummary: isAllNodesDryRun ? {
        totalNodes: this.executionOrder.length,
        dryRunNodes: dryRunNodes.length,
        simulationStrategies: hasSimulatedContext ? context.metadata.simulatedContext?.dataFlowPath : [],
        contextPropagation: hasSimulatedContext
      } : undefined
    };

    return response;
  }

  /**
   * 检查是否为dry-run结果
   */
  private isDryRunResult(result: any): result is NodeDryRunResult {
    return result && typeof result === 'object' && 'nodeId' in result && 'status' in result;
  }

  /**
   * 触发事件
   */
  private emitEvent(event: BreakpointEvent): void {
    const handlers = this.eventHandlers.get(event.type) || [];
    handlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in event handler for ${event.type}:`, error);
      }
    });
  }

  /**
   * 获取执行上下文
   */
  getExecutionContext(requestId: string): ExecutionContext | undefined {
    return this.activeExecutions.get(requestId);
  }

  /**
   * 获取所有注册的节点
   */
  getRegisteredNodes(): PipelineNodeInfo[] {
    return Array.from(this.pipelineNodes.values());
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.pipelineNodes.clear();
    this.executionOrder = [];
    this.eventHandlers.clear();
    this.activeExecutions.clear();
    pipelineDryRunManager.clear();
  }
}

/**
 * 导出单例实例
 */
export const dryRunPipelineExecutor = new DryRunPipelineExecutor();
