/**
 * Testing utilities for pipeline modules
 */

import type { PipelineConfig, ModuleDependencies } from '../interfaces/pipeline-interfaces.js';
import { BasePipeline } from '../core/base-pipeline.js';
import type { ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';

/**
 * Create a mock pipeline for testing
 */
export async function createMockPipeline(
  config?: Partial<PipelineConfig>
): Promise<BasePipeline> {
  const mockConfig: PipelineConfig = {
    id: 'test-pipeline',
    provider: {
      type: 'mock',
      baseUrl: 'http://localhost:8080',
      auth: { type: 'none' }
    },
    modules: {
      llmSwitch: {
        type: 'mock',
        config: {}
      },
      workflow: {
        type: 'mock',
        config: {}
      },
      compatibility: {
        type: 'mock',
        config: {}
      },
      provider: {
        type: 'mock',
        config: {}
      }
    },
    ...config
  };

  const mockErrorHandlingCenter = {} as ErrorHandlingCenter;
  const mockDebugCenter = {} as DebugCenter;

  const pipeline = new BasePipeline(
    mockConfig,
    mockErrorHandlingCenter,
    mockDebugCenter,
    async (_moduleConfig, _dependencies) => {
      throw new Error('Mock module factory not implemented');
    }
  );

  await pipeline.initialize();
  return pipeline;
}

/**
 * Create test pipeline configuration
 */
export function createTestPipelineConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    id: 'test-pipeline',
    provider: {
      type: 'test',
      baseUrl: 'http://localhost:8080',
      auth: { type: 'none' }
    },
    modules: {
      llmSwitch: {
        type: 'test',
        config: {}
      },
      workflow: {
        type: 'test',
        config: {}
      },
      compatibility: {
        type: 'test',
        config: {}
      },
      provider: {
        type: 'test',
        config: {}
      }
    },
    ...overrides
  };
}

/**
 * Create test module dependencies
 */
export function createTestModuleDependencies(): ModuleDependencies {
  return {
    errorHandlingCenter: {} as any,
    debugCenter: {} as any,
    logger: {} as any
  };
}