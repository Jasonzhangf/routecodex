import { describe, it, expect, jest } from '@jest/globals';
import { PipelineContext } from '../pipeline-context.js';
import type { PipelineBlueprint, PipelineNodeDescriptor } from '../types.js';

const sampleBlueprint: PipelineBlueprint = {
  id: 'pipeline-unit-test',
  name: 'unit-test',
  phase: 'request',
  entryEndpoints: ['/v1/chat/completions'],
  providerProtocols: ['openai-chat'],
  processMode: 'chat',
  streaming: 'auto',
  nodes: [
    {
      id: 'node-a',
      kind: 'process',
      implementation: 'noop-process'
    }
  ]
};

const baseMetadata = {
  requestId: 'req-unit-test',
  entryEndpoint: '/v1/chat/completions',
  pipelineId: 'pipeline-unit-test'
};

describe('PipelineContext error & warning reporting', () => {
  it('wraps node errors and triggers error callback', async () => {
    const context = new PipelineContext(sampleBlueprint, 'request', { ...baseMetadata });
    const descriptor: PipelineNodeDescriptor = {
      id: 'node-b',
      kind: 'process',
      implementation: 'failing-process'
    };
    const errorCallback = jest.fn().mockResolvedValue(undefined);
    context.errorCallback = errorCallback;

    const originalError = new Error('boom');
    const wrappedError = await context.reportNodeError(descriptor, originalError);

    expect(wrappedError).toBeInstanceOf(Error);
    expect(wrappedError.nodeId).toBe('node-b');
    expect(wrappedError.implementation).toBe('failing-process');
    expect(wrappedError.stage).toBe('process:node-b');
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(errorCallback).toHaveBeenCalledWith(wrappedError);
  });

  it('forwards warnings with stage metadata', async () => {
    const context = new PipelineContext(sampleBlueprint, 'request', { ...baseMetadata });
    const descriptor: PipelineNodeDescriptor = {
      id: 'node-c',
      kind: 'input',
      implementation: 'noop-input'
    };
    const warningCallback = jest.fn().mockResolvedValue(undefined);
    context.warningCallback = warningCallback;

    await context.reportNodeWarning(descriptor, 'soft issue', { foo: 'bar' });

    expect(warningCallback).toHaveBeenCalledTimes(1);
    expect(warningCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'node-c',
        stage: 'input:node-c',
        message: 'soft issue',
        detail: { foo: 'bar' }
      })
    );
  });
});
