import { describe, it, expect } from '@jest/globals';

import type { SharedPipelineRequest } from '../src/types/shared-dtos';
import type { ModuleConfig, ModuleDependencies, PipelineConfig } from '../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { BasePipeline } from '../src/modules/pipeline/core/base-pipeline.js';

// Modules
import { OpenAINormalizerLLMSwitch } from '../src/modules/pipeline/modules/llmswitch/openai-normalizer.js';
import { StreamingControlWorkflow } from '../src/modules/pipeline/modules/workflow/streaming-control.js';
import { FieldMappingCompatibility } from '../src/modules/pipeline/modules/compatibility/field-mapping.js';
import { GenericHTTPProvider } from '../src/modules/pipeline/modules/provider/generic-http-provider.js';

// Minimal centers
const errorHandlingCenter = {
  async handleError() {/* noop */},
} as any;

const debugCenter = {
  processDebugEvent: () => void 0,
  logDebug: () => void 0,
  logError: () => void 0,
  logModule: () => void 0,
  getLogs: () => [],
} as any;

const deps: ModuleDependencies = {
  errorHandlingCenter,
  debugCenter,
  logger: {
    logModule: () => void 0,
    logError: () => void 0,
    logDebug: () => void 0,
    logPipeline: () => void 0,
    logRequest: () => void 0,
    logResponse: () => void 0,
    logTransformation: () => void 0,
    logProviderRequest: () => void 0,
    getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
    getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
    getRecentLogs: () => [],
    getTransformationLogs: () => [],
    getProviderLogs: () => [],
    getStatistics: () => ({ totalLogs: 0, logsByLevel: {}, logsByCategory: {}, logsByPipeline: {}, transformationCount: 0, providerRequestCount: 0 }),
    clearLogs: () => void 0,
    exportLogs: () => ({}),
    log: () => void 0,
  } as any,
};

// Simple factory mapping by type
async function moduleFactory(moduleConfig: ModuleConfig): Promise<any> {
  switch (moduleConfig.type) {
    case 'llmswitch-openai-openai':
      return new OpenAINormalizerLLMSwitch(moduleConfig, deps);
    case 'streaming-control':
      return new StreamingControlWorkflow(moduleConfig, deps);
    case 'field-mapping':
      return new FieldMappingCompatibility(moduleConfig, deps);
    case 'generic-http':
      return new GenericHTTPProvider(moduleConfig, deps);
    default:
      throw new Error(`Unknown module type in test: ${moduleConfig.type}`);
  }
}

describe('BasePipeline end-to-end (DTO)', () => {
  it('runs through llmswitch -> workflow -> compatibility -> provider and returns mapped model', async () => {
    const cfg: PipelineConfig = {
      id: 'test.pipeline',
      provider: { type: 'generic-http' } as any,
      modules: {
        llmSwitch: { type: 'llmswitch-openai-openai', config: {} },
        workflow: { type: 'streaming-control', config: {} },
        compatibility: {
          type: 'field-mapping',
          config: {
            rules: [
              {
                id: 'model-mapping',
                transform: 'mapping',
                sourcePath: 'model',
                targetPath: 'model',
                mapping: { 'gpt-4': 'gpt-4o-mini' },
              },
            ],
          },
        },
        provider: {
          type: 'generic-http',
          config: {
            type: 'openai',
            baseUrl: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'test-key', headerName: 'x-api-key', prefix: '' },
          },
        },
      },
      settings: { debugEnabled: true },
    } as any;

    const pipeline = new BasePipeline(cfg, errorHandlingCenter, debugCenter, async (mc, _deps) => moduleFactory(mc));
    await pipeline.initialize();

    const request: SharedPipelineRequest = {
      data: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: null }],
        stream: true,
      },
      route: { providerId: 'test', modelId: 'gpt-4', requestId: 'req_e2e', timestamp: Date.now() },
      metadata: {},
      debug: { enabled: true, stages: {} },
    };

    const response = await pipeline.processRequest(request);
    expect(response).toBeTruthy();
    expect(response.metadata.pipelineId).toBe('test.pipeline');
    const body = response.data as any;
    // GenericHTTPProvider echoes request.model -> after mapping should be gpt-4o-mini
    expect(body.model).toBe('gpt-4o-mini');
    // choices should exist in simulated response
    expect(Array.isArray(body.choices)).toBe(true);
  });
});

