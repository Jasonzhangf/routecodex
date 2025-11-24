import type { PipelineNodeDescriptor } from './types.js';
import type { PipelineNode } from './pipeline-node.js';

type NodeFactory = (descriptor: PipelineNodeDescriptor) => PipelineNode;

export class PipelineNodeRegistry {
  private factories: Map<string, NodeFactory> = new Map();

  register(implementation: string, factory: NodeFactory): void {
    this.factories.set(implementation, factory);
  }

  create(descriptor: PipelineNodeDescriptor): PipelineNode | null {
    const factory = this.factories.get(descriptor.implementation);
    if (!factory) {
      return null;
    }
    return factory(descriptor);
  }
}
