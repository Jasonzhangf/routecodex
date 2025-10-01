import { describe, it, expect } from '@jest/globals';

import type { SharedPipelineRequest } from '../src/types/shared-dtos';
import { PipelineDebugLogger } from '../src/modules/pipeline/utils/debug-logger.js';

// LLMSwitch
import { OpenAINormalizerLLMSwitch } from '../src/modules/pipeline/modules/llmswitch/openai-normalizer.js';
// Workflow
import { StreamingControlWorkflow } from '../src/modules/pipeline/modules/workflow/streaming-control.js';
// Compatibility
import { FieldMappingCompatibility } from '../src/modules/pipeline/modules/compatibility/field-mapping.js';

const dummyDebugCenter = {
  processDebugEvent: () => void 0,
};

function makeLogger() {
  return new PipelineDebugLogger(dummyDebugCenter as any);
}

function makeDto(overrides?: Partial<SharedPipelineRequest>): SharedPipelineRequest {
  return {
    data: {
      model: 'gpt-4',
      messages: [{ role: 'user', content: null }],
      stream: true,
    },
    route: {
      providerId: 'test',
      modelId: 'gpt-4',
      requestId: 'req_1',
      timestamp: Date.now(),
    },
    metadata: {},
    debug: { enabled: true, stages: {} },
    ...(overrides as any),
  };
}

describe('Pipeline DTO flow', () => {
  it('LLMSwitch (OpenAI normalizer) returns DTO and normalizes message content', async () => {
    const llm = new OpenAINormalizerLLMSwitch({ type: 'llmswitch-openai-openai', config: {} }, { logger: makeLogger() } as any);
    await llm.initialize();
    const input = makeDto();
    const out = await llm.processIncoming(input);
    expect(out).toBeTruthy();
    expect(out.route.requestId).toBe(input.route.requestId);
    // normalized content should be string when original is null
    const first = (out.data as any).messages?.[0];
    expect(typeof first?.content).toBe('string');
  });

  it('Workflow (streaming-control) converts stream=true to false and returns DTO', async () => {
    const wf = new StreamingControlWorkflow({ type: 'streaming-control', config: {} }, { logger: makeLogger() } as any);
    await wf.initialize();
    const input = makeDto();
    const out = await wf.processIncoming(input);
    expect(out).toBeTruthy();
    expect(out.route.requestId).toBe(input.route.requestId);
    expect((out.data as any).stream).toBe(false);
  });

  it('Compatibility (field-mapping) applies mapping rules to DTO.data and returns DTO', async () => {
    const rules = [
      {
        id: 'map-model',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: { 'gpt-4': 'gpt-4o-mini' },
      },
    ];
    const comp = new FieldMappingCompatibility({ type: 'field-mapping', config: { rules } }, { logger: makeLogger() } as any);
    await comp.initialize();
    const input = makeDto();
    const out = await comp.processIncoming(input);
    expect(out).toBeTruthy();
    expect(out.route.requestId).toBe(input.route.requestId);
    expect((out.data as any).model).toBe('gpt-4o-mini');
  });
});

