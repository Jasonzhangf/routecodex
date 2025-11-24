import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../types/shared-dtos.js';
import type { PipelineBlueprint, PipelineNodeDescriptor, PipelinePhase } from './types.js';
import {
  createPipelineNodeError,
  createPipelineNodeWarning,
  isPipelineNodeError,
  type PipelineErrorCallback,
  type PipelineWarningCallback,
  type PipelineNodeError
} from './pipeline-node-errors.js';

export interface PipelineMetadata {
  requestId: string;
  entryEndpoint: string;
  providerProtocol?: string;
  processMode?: 'chat' | 'passthrough';
  streaming?: 'auto' | 'always' | 'never';
  routeName?: string;
  pipelineId?: string;
  providerId?: string;
  modelId?: string;
}

export class PipelineContext {
  readonly blueprint: PipelineBlueprint;
  readonly phase: PipelinePhase;
  nodes: PipelineNodeDescriptor[];

  request?: SharedPipelineRequest;
  response?: SharedPipelineResponse;
  metadata: PipelineMetadata;
  extra: Record<string, unknown>;
  errorCallback?: PipelineErrorCallback;
  warningCallback?: PipelineWarningCallback;

  constructor(blueprint: PipelineBlueprint, phase: PipelinePhase, metadata: PipelineMetadata) {
    this.blueprint = blueprint;
    this.phase = phase;
    this.nodes = [...blueprint.nodes];
    this.metadata = metadata;
    this.extra = {};
  }

  async reportNodeError(descriptor: PipelineNodeDescriptor, error: unknown): Promise<PipelineNodeError> {
    const pipelineError = isPipelineNodeError(error)
      ? error
      : createPipelineNodeError({
          error,
          nodeId: descriptor.id,
          implementation: descriptor.implementation,
          pipelineId: this.metadata.pipelineId || this.blueprint.id,
          requestId: this.metadata.requestId,
          phase: this.phase,
          stage: this.resolveStage(descriptor),
          metadata: {
            kind: descriptor.kind,
            options: descriptor.options
          }
        });
    if (this.errorCallback) {
      await this.errorCallback(pipelineError);
    }
    return pipelineError;
  }

  async reportNodeWarning(descriptor: PipelineNodeDescriptor, message: string, detail?: unknown): Promise<void> {
    if (!this.warningCallback) return;
    const warning = createPipelineNodeWarning({
      nodeId: descriptor.id,
      implementation: descriptor.implementation,
      pipelineId: this.metadata.pipelineId || this.blueprint.id,
      requestId: this.metadata.requestId,
      phase: this.phase,
      stage: this.resolveStage(descriptor),
      message,
      detail
    });
    await this.warningCallback(warning);
  }

  private resolveStage(descriptor: PipelineNodeDescriptor): string {
    if (descriptor.options && typeof descriptor.options['stage'] === 'string') {
      return descriptor.options['stage'] as string;
    }
    return `${descriptor.kind}:${descriptor.id}`;
  }
}
