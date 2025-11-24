import { NodeFactory } from 'rcc-llmswitch-core/v2/conversion/conversion-v3/nodes/index';
import { getDefaultNodeConfig } from 'rcc-llmswitch-core/v2/conversion/conversion-v3/config/default-configs';
import type {
  NodeConfig,
  NodeContext,
  NodeResult,
  NodeType
} from 'rcc-llmswitch-core/v2/conversion/conversion-v3/types/index';
import type { PipelineNode } from '../../orchestrator/pipeline-node.js';
import type { PipelineContext } from '../../orchestrator/pipeline-context.js';
import type { PipelineNodeDescriptor } from '../../orchestrator/types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';

interface LlmswitchRuntimeState {
  currentData: Record<string, unknown>;
  previousResults: NodeResult[];
  startTime: number;
}

export class LlmswitchNode implements PipelineNode {
  readonly id: string;
  readonly descriptor: PipelineNodeDescriptor;
  private readonly nodeConfig: NodeConfig;
  private readonly nodeType: NodeType;
  private readonly implementation: string;
  private readonly node: any;

  constructor(descriptor: PipelineNodeDescriptor) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.implementation = descriptor.implementation;
    this.nodeConfig = this.buildNodeConfig(descriptor);
    this.nodeType = this.mapKindToNodeType(descriptor);
    this.node = NodeFactory.createNode(this.nodeType, descriptor.id, this.nodeConfig);
  }

  async execute(context: PipelineContext): Promise<void> {
    const runtime = this.getRuntimeState(context);
    const nodeContext = this.buildNodeContext(context, runtime);
    const result = await this.node.execute(nodeContext);
    if (!result || result.success !== true) {
      throw new Error(result?.error?.message || '[llmswitch-node] node execution failed');
    }
    runtime.previousResults.push(result);
    if (result.data && typeof result.data === 'object') {
      runtime.currentData = result.data as Record<string, unknown>;
    }
    this.handlePostExecutionEffects(context, result);
  }

  private handlePostExecutionEffects(context: PipelineContext, result: NodeResult): void {
    if (context.phase === 'request' && this.isProviderOutputNode()) {
      context.extra.providerPayload = result.data;
    }
    if (context.phase === 'response' && this.isOutputNode()) {
      const conversionResponse = (result.data as any)?.conversionResponse;
      if (conversionResponse && typeof conversionResponse === 'object') {
          context.response = this.createResponseFromConversion(conversionResponse, context);
      } else if (!context.response && result.data && typeof result.data === 'object') {
        context.response = { data: result.data as Record<string, unknown>, metadata: {} } as SharedPipelineResponse;
      }
    }
  }

  private createResponseFromConversion(conversion: any, context: PipelineContext): SharedPipelineResponse {
    const metadata = {
      pipelineId: conversion.metadata?.pipeline?.id || context.metadata.pipelineId || this.descriptor.id,
      processingTime: conversion.metadata?.conversionTime || 0,
      stages: [] as string[],
      requestId: context.metadata.requestId
    };
    return {
      data: conversion.data,
      metadata
    } as SharedPipelineResponse;
  }

  private isOutputNode(): boolean {
    return this.descriptor.kind === 'output' || this.descriptor.kind === 'sse-output';
  }

  private isProviderOutputNode(): boolean {
    return this.isOutputNode() && ['openai-output', 'responses-output', 'anthropic-output'].includes(this.implementation);
  }

  private buildNodeContext(context: PipelineContext, runtime: LlmswitchRuntimeState): NodeContext {
    const payload = runtime.currentData;
    const metadata = {
      ...context.metadata,
      phase: context.phase
    } as Record<string, unknown>;
    const request: Record<string, unknown> = {
      id: context.metadata.requestId,
      timestamp: Date.now(),
      endpoint: context.metadata.entryEndpoint,
      payload,
      context: {
        entryEndpoint: context.metadata.entryEndpoint,
        metadata
      },
      options: {
        provider: context.metadata.providerProtocol,
        providerType: this.inferProviderType(context.metadata.providerProtocol),
        streamingFormat: context.metadata.streaming === 'always' ? 'sse' : 'json',
        processMode: context.metadata.processMode,
        stage: context.phase === 'response' ? 'outbound' : 'inbound'
      }
    };

    return {
      request: request as any,
      data: payload,
      pipeline: {
        currentNode: this.id,
        previousResults: runtime.previousResults,
        isPassthrough: context.metadata.processMode === 'passthrough',
        startTime: runtime.startTime
      },
      nodeConfig: this.nodeConfig,
      callbacks: null
    } as NodeContext;
  }

  private getRuntimeState(context: PipelineContext): LlmswitchRuntimeState {
    const key = context.phase === 'response' ? '__llmswitchRuntimeResponse' : '__llmswitchRuntimeRequest';
    if (!context.extra[key]) {
      const seed = context.phase === 'response'
        ? this.normalizeSeedData(context.response?.data)
        : this.normalizeSeedData((context.request as SharedPipelineRequest | undefined)?.data);
      context.extra[key] = {
        currentData: seed,
        previousResults: [],
        startTime: Date.now()
      } satisfies LlmswitchRuntimeState;
    }
    return context.extra[key] as LlmswitchRuntimeState;
  }

  private normalizeSeedData(payload?: unknown): Record<string, unknown> {
    if (payload && typeof payload === 'object') {
      return { ...(payload as Record<string, unknown>) };
    }
    return {};
  }

  private buildNodeConfig(descriptor: PipelineNodeDescriptor): NodeConfig {
    const defaults = getDefaultNodeConfig(descriptor.implementation);
    const base: NodeConfig = defaults
      ? JSON.parse(JSON.stringify(defaults))
      : {
          id: descriptor.id,
          type: this.mapKindToNodeType(descriptor),
          name: descriptor.implementation,
          inputFormat: descriptor.kind,
          outputFormat: descriptor.kind,
          rules: [],
          validation: { strict: false, required: [], optional: [] },
          timeout: 5000
        } as NodeConfig;
    base.id = descriptor.id;
    base.type = base.type ?? this.mapKindToNodeType(descriptor);
    if (descriptor.options) {
      base.options = { ...(base.options || {}), ...descriptor.options };
    }
    (base as any).__implementation = descriptor.implementation;
    return base;
  }

  private mapKindToNodeType(descriptor: PipelineNodeDescriptor): NodeType {
    if (descriptor.kind === 'process' || descriptor.kind === 'compatibility') {
      return 'process' as NodeType;
    }
    if (descriptor.kind === 'output' || descriptor.kind === 'sse-output') {
      return 'output' as NodeType;
    }
    return 'input' as NodeType;
  }

  private inferProviderType(protocol?: string): string {
    const value = (protocol || '').toLowerCase();
    if (value.includes('anthropic')) return 'anthropic';
    if (value.includes('responses')) return 'responses';
    if (value.includes('gemini')) return 'gemini';
    return 'openai';
  }
}
