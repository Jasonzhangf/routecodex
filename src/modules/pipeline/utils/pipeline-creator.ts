/**
 * Pipeline creation utility functions
 */

import type { PipelineConfig, /* ModuleDependencies */ } from '../interfaces/pipeline-interfaces.js';
import { BasePipeline } from '../core/base-pipeline.js';
import type { ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { PipelineBlueprint } from '../orchestrator/types.js';

/**
 * Create a pipeline with the given configuration
 */
export async function createPipeline(
  config: PipelineConfig,
  errorHandlingCenter: ErrorHandlingCenter,
  debugCenter: DebugCenter,
  blueprint?: PipelineBlueprint
): Promise<BasePipeline> {
  const pipeline = new BasePipeline(
    config,
    errorHandlingCenter,
    debugCenter,
    async (_moduleConfig, _dependencies) => {
      // Default module factory - in a real implementation this would be more sophisticated
      throw new Error('Module factory not implemented');
    },
    blueprint ? { request: blueprint } : undefined
  );

  await pipeline.initialize();
  return pipeline;
}
