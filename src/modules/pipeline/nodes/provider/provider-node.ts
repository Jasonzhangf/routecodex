import type { PipelineNodeDescriptor } from '../../orchestrator/types.js';
import type { PipelineNode } from '../../orchestrator/pipeline-node.js';
import type { PipelineContext } from '../../orchestrator/pipeline-context.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { PipelineSnapshotRecorder } from '../../utils/pipeline-snapshot-recorder.js';
import { buildProviderResponseArtifacts } from './provider-utils.js';

export class ProviderNode implements PipelineNode {
  readonly id: string;
  readonly descriptor: PipelineNodeDescriptor;

  constructor(descriptor: PipelineNodeDescriptor) {
    this.id = descriptor.id;
    this.descriptor = descriptor;
  }

  async execute(context: PipelineContext): Promise<void> {
    if (context.phase !== 'request') {
      await context.reportNodeWarning(this.descriptor, 'ProviderNode 仅在请求阶段执行，响应阶段将被忽略');
      return;
    }
    if (!context.request) {
      throw new Error('[ProviderNode] context.request 缺失');
    }
    const pipeline = context.extra['pipelineInstance'] as any;
    if (!pipeline?.processProvider) {
      throw new Error('[ProviderNode] 无法获取 pipeline provider 执行器');
    }
    const snapshotRecorder = context.extra['snapshotRecorder'] as PipelineSnapshotRecorder | undefined;
    const sharedRequest = context.request as SharedPipelineRequest;
    const rawPayload = await pipeline.processProvider(sharedRequest, snapshotRecorder);

    const artifacts = await buildProviderResponseArtifacts({
      rawPayload: rawPayload as UnknownObject,
      request: sharedRequest,
      metadata: context.metadata,
      pipelineId: context.metadata.pipelineId || pipeline?.pipelineId || 'unknown',
      providerModuleType: extractProviderModuleType(pipeline)
    });

    context.extra['providerPayload'] = artifacts.providerPayload;
    context.response = artifacts.response;
  }
}

function extractProviderModuleType(pipeline: unknown): string | undefined {
  try {
    const cfg = (pipeline as Record<string, unknown>)?.['config'] as Record<string, unknown> | undefined;
    const modules = cfg?.['modules'] as Record<string, unknown> | undefined;
    const provider = modules?.['provider'] as Record<string, unknown> | undefined;
    const type = provider?.['type'];
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}
