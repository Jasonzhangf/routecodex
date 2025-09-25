/**
 * Dry-Run Engine - Independent Wrapper
 *
 * 提供一个独立可运行的 Dry-Run 引擎，封装现有的流水线 dry-run 能力，
 * 支持请求侧、响应侧以及双向流水线的 dry-run。
 */

import type {
  PipelineRequest,
  PipelineResponse
} from '../../pipeline/interfaces/pipeline-interfaces.js';

import type {
  NodeDryRunConfig,
  PipelineDryRunResponse
} from '../../pipeline/dry-run/pipeline-dry-run-framework.js';

import { dryRunPipelineExecutor } from '../../pipeline/dry-run/dry-run-pipeline-executor.js';
import { pipelineDryRunManager } from '../../pipeline/dry-run/pipeline-dry-run-framework.js';
import { bidirectionalPipelineManager } from '../../pipeline/dry-run/bidirectional-pipeline-dry-run.js';
import { virtualRouterDryRunExecutor } from '../../virtual-router/virtual-router-dry-run.js';
import type { VirtualRouterDryRunResult } from '../../virtual-router/virtual-router-dry-run.js';

export type DryRunMode = 'normal' | 'dry-run' | 'mixed';
export type DryRunScope = 'routing-only' | 'pipeline-only' | 'full'; // 新增：dry-run作用域

export interface RunRequestOptions {
  mode?: DryRunMode;
  scope?: DryRunScope; // 新增：指定dry-run作用域
  nodeConfigs?: Record<string, NodeDryRunConfig>;
  pipelineId?: string;
  includeVirtualRouter?: boolean; // 是否包含虚拟路由器dry-run
  virtualRouterConfig?: {
    includeLoadBalancerDetails?: boolean;
    includeHealthStatus?: boolean;
    includeWeightCalculation?: boolean;
    simulateProviderHealth?: boolean;
  };
}

export interface ExtendedDryRunResponse {
  virtualRouter?: VirtualRouterDryRunResult;
  pipeline?: PipelineDryRunResponse;
  combinedAnalysis?: {
    totalExecutionTime: number;
    routingAccuracy: number;
    loadBalancerEffectiveness: number;
  };
}

export interface RunResponseOptions {
  mode?: Extract<DryRunMode, 'dry-run' | 'mixed'>;
  nodeConfigs?: Record<string, NodeDryRunConfig>;
  pipelineId?: string;
}

export interface RunBidirectionalOptions {
  pipelineId?: string;
  nodeConfigs?: {
    request?: Record<string, NodeDryRunConfig>;
    response?: Record<string, NodeDryRunConfig>;
  };
}

export class DryRunEngine {
  /**
   * 运行请求侧流水线（支持三种dry-run模式）
   */
  async runRequest(
    request: PipelineRequest,
    options: RunRequestOptions = {}
  ): Promise<PipelineResponse | PipelineDryRunResponse | ExtendedDryRunResponse> {
    const mode: DryRunMode = options.mode ?? 'dry-run';
    const scope: DryRunScope = options.scope ?? 'full'; // 默认完整模式
    const pipelineId = options.pipelineId ?? 'request-pipeline';

    if (options.nodeConfigs) {
      pipelineDryRunManager.configureNodesDryRun(options.nodeConfigs);
    }

    // 根据作用域选择执行模式
    switch (scope) {
      case 'routing-only':
        // 仅调度模式：只执行虚拟路由器dry-run
        return await this.executeRoutingOnlyDryRun(request, options);
        
      case 'pipeline-only':
        // 仅流水线模式：跳过调度，直接执行流水线dry-run
        return await dryRunPipelineExecutor.executePipeline(request, pipelineId, mode);
        
      case 'full':
      default:
        // 完整模式：调度 + 流水线dry-run
        return await this.executeFullDryRun(request, options, mode, pipelineId);
    }
  }

  /**
   * 仅调度模式：只执行虚拟路由器dry-run，不执行流水线
   */
  private async executeRoutingOnlyDryRun(
    request: PipelineRequest,
    options: RunRequestOptions
  ): Promise<ExtendedDryRunResponse> {
    const startTime = Date.now();

    try {
      // 配置虚拟路由器dry-run
      virtualRouterDryRunExecutor.updateConfig({
        enabled: true,
        includeLoadBalancerDetails: options.virtualRouterConfig?.includeLoadBalancerDetails ?? true,
        includeHealthStatus: options.virtualRouterConfig?.includeHealthStatus ?? true,
        includeWeightCalculation: options.virtualRouterConfig?.includeWeightCalculation ?? true,
        simulateProviderHealth: options.virtualRouterConfig?.simulateProviderHealth ?? true
      });

      // 执行虚拟路由器dry-run
      const virtualRouterResult = await virtualRouterDryRunExecutor.executeDryRun({
        request: request.data,
        endpoint: request.route?.providerId ? `/v1/${request.route.providerId}/chat/completions` : '/v1/chat/completions',
        protocol: 'openai'
      });

      // 构建调度专用响应
      const routingAnalysis = {
        totalExecutionTime: Date.now() - startTime,
        routingAccuracy: virtualRouterResult.routingDecision?.confidence || 0,
        loadBalancerEffectiveness: this.calculateLoadBalancerEffectiveness(virtualRouterResult),
        scope: 'routing-only' as const,
        message: 'Virtual router dry-run completed - pipeline execution skipped'
      };

      return {
        virtualRouter: virtualRouterResult,
        pipeline: undefined, // 流水线未执行
        combinedAnalysis: routingAnalysis
      };

    } catch (error) {
      console.error('Routing-only dry-run execution failed:', error);
      throw error;
    }
  }

  /**
   * 执行仅调度模式（虚拟路由器dry-run）
   */
  private async executeRoutingOnlyDryRun(
    request: PipelineRequest,
    options: RunRequestOptions
  ): Promise<ExtendedDryRunResponse> {
    const startTime = Date.now();

    try {
      // 配置虚拟路由器dry-run
      virtualRouterDryRunExecutor.updateConfig({
        enabled: true,
        includeLoadBalancerDetails: options.virtualRouterConfig?.includeLoadBalancerDetails ?? true,
        includeHealthStatus: options.virtualRouterConfig?.includeHealthStatus ?? true,
        includeWeightCalculation: options.virtualRouterConfig?.includeWeightCalculation ?? true,
        simulateProviderHealth: options.virtualRouterConfig?.simulateProviderHealth ?? true
      });

      // 执行虚拟路由器dry-run
      const virtualRouterResult = await virtualRouterDryRunExecutor.executeDryRun({
        request: request.data,
        endpoint: request.route?.providerId ? `/v1/${request.route.providerId}/chat/completions` : '/v1/chat/completions',
        protocol: 'openai'
      });

      // 不执行流水线，只返回调度结果
      return {
        virtualRouter: virtualRouterResult,
        pipeline: undefined, // 流水线未执行
        combinedAnalysis: {
          totalExecutionTime: Date.now() - startTime,
          routingAccuracy: virtualRouterResult.routingDecision?.confidence || 0,
          loadBalancerEffectiveness: this.calculateLoadBalancerEffectiveness(virtualRouterResult)
        }
      };

    } catch (error) {
      console.error('Routing-only dry-run execution failed:', error);
      throw error;
    }
  }

  /**
   * 执行完整模式（调度 + 流水线dry-run）
   */
  private async executeFullDryRun(
    request: PipelineRequest,
    options: RunRequestOptions,
    mode: DryRunMode,
    pipelineId: string
  ): Promise<ExtendedDryRunResponse> {
    const startTime = Date.now();

    try {
      // 配置虚拟路由器dry-run
      virtualRouterDryRunExecutor.updateConfig({
        enabled: true,
        includeLoadBalancerDetails: options.virtualRouterConfig?.includeLoadBalancerDetails ?? true,
        includeHealthStatus: options.virtualRouterConfig?.includeHealthStatus ?? true,
        includeWeightCalculation: options.virtualRouterConfig?.includeWeightCalculation ?? true,
        simulateProviderHealth: options.virtualRouterConfig?.simulateProviderHealth ?? true
      });

      // 1. 执行虚拟路由器dry-run
      const virtualRouterResult = await virtualRouterDryRunExecutor.executeDryRun({
        request: request.data,
        endpoint: request.route?.providerId ? `/v1/${request.route.providerId}/chat/completions` : '/v1/chat/completions',
        protocol: 'openai'
      });

      // 2. 执行流水线dry-run
      const pipelineResult = await dryRunPipelineExecutor.executePipeline(request, pipelineId, mode);

      // 3. 组合分析结果
      const combinedAnalysis = {
        totalExecutionTime: Date.now() - startTime,
        routingAccuracy: virtualRouterResult.routingDecision?.confidence || 0,
        loadBalancerEffectiveness: this.calculateLoadBalancerEffectiveness(virtualRouterResult)
      };

      return {
        virtualRouter: virtualRouterResult,
        pipeline: pipelineResult as PipelineDryRunResponse,
        combinedAnalysis
      };

    } catch (error) {
      console.error('Full dry-run execution failed:', error);
      throw error;
    }
  }

  /**
   * 计算负载均衡效果
   */
  private calculateLoadBalancerEffectiveness(virtualRouterResult: VirtualRouterDryRunResult): number {
    if (!virtualRouterResult.loadBalancerAnalysis) return 0;
    
    const analysis = virtualRouterResult.loadBalancerAnalysis;
    const totalProviders = Object.keys(analysis.providerWeights).length;
    const selectedWeight = analysis.providerWeights[analysis.selectedProvider] || 0;
    
    // 简单的效果计算：基于权重分布和选择合理性
    return Math.min(100, selectedWeight * 100);
  }

  /**
   * 运行响应侧流水线（使用真实响应作为输入）
   */
  async runResponse(
    realResponse: any,
    options: RunResponseOptions = {}
  ): Promise<PipelineResponse | PipelineDryRunResponse> {
    const mode: Exclude<DryRunMode, 'normal'> = options.mode ?? 'dry-run';
    const pipelineId = options.pipelineId ?? 'response-pipeline';

    if (options.nodeConfigs) {
      pipelineDryRunManager.configureNodesDryRun(options.nodeConfigs);
    }

    const responsePipelineRequest: PipelineRequest = {
      data: realResponse,
      route: {
        providerId: 'response-processor',
        modelId: 'response-model',
        requestId: `response_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {
        source: 'real',
        transformations: [],
        processingTime: 0
      },
      debug: { enabled: false, stages: {} }
    };

    return dryRunPipelineExecutor.executePipeline(responsePipelineRequest, pipelineId, mode);
  }

  /**
   * 运行双向流水线（请求 + 响应），若提供 realResponse 则直接作为响应侧输入
   */
  async runBidirectional(
    request: PipelineRequest,
    options: RunBidirectionalOptions = {},
    realResponse?: any
  ) {
    // 目前直接复用既有的双向流水线管理器，以确保稳定性
    // 节点配置（如提供）由调用方在具体 manager 上配置；此处保持无侵入
    return bidirectionalPipelineManager.executeBidirectionalPipeline(
      request,
      options.pipelineId ?? 'bidirectional-pipeline',
      realResponse
    );
  }

  /**
   * 配置（或批量配置）dry-run 节点
   */
  configureNodes(configs: Record<string, NodeDryRunConfig>): void {
    pipelineDryRunManager.configureNodesDryRun(configs);
  }
}

export const dryRunEngine = new DryRunEngine();

