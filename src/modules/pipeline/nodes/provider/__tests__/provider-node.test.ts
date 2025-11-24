import { describe, it, expect, jest } from '@jest/globals';
import { ProviderNode } from '../provider-node.js';
import { PipelineContext, type PipelineMetadata } from '../../../orchestrator/pipeline-context.js';
import type { PipelineBlueprint, PipelineNodeDescriptor } from '../../../orchestrator/types.js';
import type { SharedPipelineRequest } from '../../../../../types/shared-dtos.js';

const requestBlueprint: PipelineBlueprint = {
  id: 'pipeline-responses',
  phase: 'request',
  entryEndpoints: ['/v1/responses'],
  providerProtocols: ['openai-responses'],
  processMode: 'chat',
  streaming: 'auto',
  nodes: []
};

function createContext(metadata: Partial<PipelineMetadata> = {}): PipelineContext {
  const mergedMeta: PipelineMetadata = {
    requestId: 'req-test',
    entryEndpoint: '/v1/responses',
    pipelineId: 'pipeline-responses',
    ...metadata
  };
  return new PipelineContext(requestBlueprint, 'request', mergedMeta);
}

const descriptor: PipelineNodeDescriptor = {
  id: 'provider-http-node',
  kind: 'provider',
  implementation: 'provider-http'
};

describe('ProviderNode', () => {
  it('invokes provider and stores normalized payload + response metadata', async () => {
    const node = new ProviderNode(descriptor);
    const context = createContext({
      entryEndpoint: '/v1/responses',
      pipelineId: 'pipeline-responses'
    });
    const sharedRequest: SharedPipelineRequest = {
      data: {
        model: 'gpt-test',
        messages: []
      },
      route: {
        providerId: 'c4m',
        modelId: 'gpt-test',
        requestId: 'req-123',
        timestamp: Date.now()
      },
      metadata: {
        entryEndpoint: '/v1/responses',
        stream: true
      }
    };
    context.request = sharedRequest;
    context.extra.pipelineInstance = {
      processProvider: jest.fn().mockResolvedValue({ __sse_stream: { mock: 'stream' } }),
      config: {
        modules: {
          provider: { type: 'responses-http-provider' }
        }
      },
      pipelineId: 'pipeline-responses'
    };

    await node.execute(context);

    expect(context.extra['providerPayload']).toEqual({ __sse_responses: { mock: 'stream' } });
    expect(context.response?.metadata?.entryEndpoint).toBe('/v1/responses');
    expect(context.response?.metadata?.stream).toBe(true);
    expect(context.response?.metadata?.pipelineId).toBe('pipeline-responses');
    expect(context.response?.data).toEqual({ __sse_responses: { mock: 'stream' } });
  });

  it('reports warning when executed during response phase', async () => {
    const responseBlueprint: PipelineBlueprint = {
      ...requestBlueprint,
      phase: 'response'
    };
    const context = new PipelineContext(responseBlueprint, 'response', {
      requestId: 'req-test',
      entryEndpoint: '/v1/responses',
      pipelineId: 'pipeline-responses'
    });
    const warningCallback = jest.fn().mockResolvedValue(undefined);
    context.warningCallback = warningCallback;
    const node = new ProviderNode(descriptor);

    await node.execute(context);

    expect(warningCallback).toHaveBeenCalledTimes(1);
    expect(warningCallback.mock.calls[0][0].stage).toContain('provider');
  });
});
