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

export type DryRunMode = 'normal' | 'dry-run' | 'mixed';

export interface RunRequestOptions {
  mode?: DryRunMode;
  nodeConfigs?: Record<string, NodeDryRunConfig>;
  pipelineId?: string;
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
   * 运行请求侧流水线（支持 normal/dry-run/mixed）
   */
  async runRequest(
    request: PipelineRequest,
    options: RunRequestOptions = {}
  ): Promise<PipelineResponse | PipelineDryRunResponse> {
    const mode: DryRunMode = options.mode ?? 'dry-run';
    const pipelineId = options.pipelineId ?? 'request-pipeline';

    if (options.nodeConfigs) {
      pipelineDryRunManager.configureNodesDryRun(options.nodeConfigs);
    }

    return dryRunPipelineExecutor.executePipeline(request, pipelineId, mode);
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

