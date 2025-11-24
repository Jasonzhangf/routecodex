import { describe, it, expect, jest } from '@jest/globals';
import { CompatibilityProcessNode } from '../compatibility-node.js';
import { PipelineContext } from '../../../orchestrator/pipeline-context.js';
import type { PipelineBlueprint, PipelineNodeDescriptor } from '../../../orchestrator/types.js';

const requestBlueprint: PipelineBlueprint = {
  id: 'pipeline-openai-chat',
  phase: 'request',
  entryEndpoints: ['/v1/chat/completions'],
  providerProtocols: ['openai-chat'],
  processMode: 'chat',
  streaming: 'auto',
  nodes: []
};

const responseBlueprint: PipelineBlueprint = {
  ...requestBlueprint,
  phase: 'response'
};

describe('CompatibilityProcessNode', () => {
  it('invokes pipeline compatibility on request phase', async () => {
    const descriptor: PipelineNodeDescriptor = {
      id: 'compat-node',
      kind: 'process',
      implementation: 'compatibility-process',
      options: {
        compatibility: {
          direction: 'request'
        }
      }
    };
    const node = new CompatibilityProcessNode(descriptor);
    const context = new PipelineContext(requestBlueprint, 'request', {
      requestId: 'req-test',
      entryEndpoint: '/v1/chat/completions',
      pipelineId: 'pipeline-openai-chat'
    });
    const requestPayload = {
      data: { model: 'gpt' }
    };
    context.request = requestPayload as any;
    const runCompatibilityRequest = jest.fn().mockResolvedValue({ data: { model: 'fixed' } });
    context.extra.pipelineInstance = { runCompatibilityRequest };

    await node.execute(context);

    expect(runCompatibilityRequest).toHaveBeenCalledTimes(1);
    expect(context.request?.data).toEqual({ model: 'fixed' });
  });

  it('skips when providerMatch does not include provider', async () => {
    const descriptor: PipelineNodeDescriptor = {
      id: 'compat-node',
      kind: 'process',
      implementation: 'compatibility-process',
      options: {
        compatibility: {
          direction: 'response',
          providerMatch: ['glm']
        }
      }
    };
    const node = new CompatibilityProcessNode(descriptor);
    const context = new PipelineContext(responseBlueprint, 'response', {
      requestId: 'req-test',
      entryEndpoint: '/v1/chat/completions',
      pipelineId: 'pipeline-openai-chat',
      providerId: 'c4m'
    });
    context.response = { data: {} } as any;
    const runCompatibilityResponse = jest.fn();
    context.extra.pipelineInstance = { runCompatibilityResponse };

    await node.execute(context);

    expect(runCompatibilityResponse).not.toHaveBeenCalled();
  });
});
