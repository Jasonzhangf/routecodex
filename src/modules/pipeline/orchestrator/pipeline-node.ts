import type { PipelineContext } from './pipeline-context.js';
import type { PipelineNodeDescriptor } from './types.js';

export interface PipelineNode {
  readonly id: string;
  readonly descriptor: PipelineNodeDescriptor;
  execute(context: PipelineContext): Promise<void>;
}
