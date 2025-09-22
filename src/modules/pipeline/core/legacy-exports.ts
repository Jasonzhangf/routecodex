/**
 * Legacy exports for backward compatibility
 *
 * These exports are maintained for backward compatibility
 * but will be deprecated in future versions.
 */

import { BasePipeline } from './base-pipeline.js';
import { PipelineManager } from './pipeline-manager.js';

/**
 * Legacy BasePipeline export
 * @deprecated Use BasePipeline from './core/base-pipeline.js' instead
 */
export const LegacyBasePipeline = BasePipeline;

/**
 * Legacy PipelineManager export
 * @deprecated Use PipelineManager from './core/pipeline-manager.js' instead
 */
export const LegacyPipelineManager = PipelineManager;