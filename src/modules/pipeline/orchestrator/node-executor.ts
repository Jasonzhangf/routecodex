import type { PipelineContext } from './pipeline-context.js';
import type { PipelineNodeRegistry } from './node-registry.js';
import type { PipelineNode } from './pipeline-node.js';

export class PipelineNodeExecutor {
  constructor(private readonly registry: PipelineNodeRegistry) {}

  async execute(context: PipelineContext): Promise<void> {
    for (const descriptor of context.nodes) {
      const node = this.registry.create(descriptor);
      if (!node) {
        const pipelineError = await context.reportNodeError(descriptor, new Error(`[PipelineNodeExecutor] 未注册的节点实现: ${descriptor.implementation}`));
        throw pipelineError;
      }
      try {
        await node.execute(context);
      } catch (error) {
        const pipelineError = await context.reportNodeError(descriptor, error);
        throw pipelineError;
      }
    }
  }
}
