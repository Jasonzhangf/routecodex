import type { PipelineNode } from '../../orchestrator/pipeline-node.js';
import type { PipelineContext } from '../../orchestrator/pipeline-context.js';
import type { PipelineNodeDescriptor } from '../../orchestrator/types.js';

type TargetPayload = 'request' | 'response' | 'none';

/**
 * Minimal placeholder node used for passthrough pipelines.
 * Ensures required payload is present but otherwise leaves data untouched.
 */
export class PassThroughNode implements PipelineNode {
  readonly id: string;
  readonly descriptor: PipelineNodeDescriptor;
  private readonly target: TargetPayload;

  constructor(descriptor: PipelineNodeDescriptor, target: TargetPayload = 'none') {
    this.id = descriptor.id;
    this.descriptor = descriptor;
    this.target = target;
  }

  async execute(context: PipelineContext): Promise<void> {
    if (this.target === 'request' && !context.request) {
      throw new Error(`[PassThroughNode] 缺少 request payload (${this.descriptor.implementation})`);
    }
    if (this.target === 'response' && !context.response) {
      throw new Error(`[PassThroughNode] 缺少 response payload (${this.descriptor.implementation})`);
    }
    // no-op for passthrough pipelines
  }
}
