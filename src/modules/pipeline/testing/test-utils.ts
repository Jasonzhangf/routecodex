/**
 * Testing utilities for pipeline modules
 */

import { LOCAL_HOSTS, HTTP_PROTOCOLS, DEFAULT_CONFIG } from "../../../constants/index.js";import type { PipelineConfig, ModuleDependencies } from '../interfaces/pipeline-interfaces.js';
import { BasePipeline } from '../core/base-pipeline.js';
import type { ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type { PipelineBlueprint } from '../orchestrator/types.js';

/**
 * Create a mock pipeline for testing
 */
export async function createMockPipeline(
  config?: Partial<PipelineConfig>,
  blueprint?: PipelineBlueprint
): Promise<BasePipeline> {
  const mockConfig: PipelineConfig = {
    id: 'test-pipeline',
    provider: {
      type: 'mock',
      baseUrl: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.OAUTH_CALLBACK_PORT}`,
      auth: { type: 'none' }
    },
    modules: {
      llmSwitch: {
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
    },
    blueprint ? { request: blueprint } : undefined
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
      baseUrl: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.OAUTH_CALLBACK_PORT}`,
      auth: { type: 'none' }
    },
    modules: {
      llmSwitch: {
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
