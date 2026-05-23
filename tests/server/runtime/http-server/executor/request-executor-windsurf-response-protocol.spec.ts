import { describe, expect, it, jest } from '@jest/globals';

import type { PipelineExecutionInput } from '../../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { StatsManager } from '../../../../../src/server/runtime/http-server/stats-manager.js';

const mockConvertProviderResponseIfNeeded = jest.fn(async (options: any) => ({
  ...options.response,
  body: {
    id: 'resp_windsurf_submit_remapped',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        status: 'completed',
        call_id: 'native:run_command:3',
        name: 'run_command',
        arguments: '{\"command_line\":\"pwd\",\"cwd\":\"/Users/fanzhang/Documents/github/routecodex\"}'
      }
    ],
    observed_provider_protocol: options.providerProtocol
  }
}));

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js',
  () => ({
    convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
  })
);

function createWindsurfHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    runtimeKey: 'windsurf.ws-pro-4',
    providerId: 'windsurf',
    providerType: 'openai',
    providerFamily: 'windsurf',
    providerProtocol: 'openai-responses',
    runtime: {
      runtimeKey: 'windsurf.ws-pro-4',
      providerId: 'windsurf',
      keyAlias: 'ws-pro-4',
      providerType: 'openai',
      providerFamily: 'windsurf',
      endpoint: 'https://example.invalid',
      auth: { type: 'none' },
      outboundProfile: 'openai-responses'
    },
    instance: {
      initialize: jest.fn(async () => undefined),
      cleanup: jest.fn(async () => undefined),
      processIncoming: jest.fn(processImpl)
    }
  } as unknown as ProviderHandle;
}

function createDeps(handle: ProviderHandle, pipeline: HubPipeline) {
  return {
    runtimeManager: {
      resolveRuntimeKey: jest.fn(() => 'windsurf.ws-pro-4'),
      getHandleByRuntimeKey: jest.fn(() => handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    },
    getHubPipeline: () => pipeline,
    getModuleDependencies: (): ModuleDependencies => ({
      errorHandlingCenter: {
        handleError: jest.fn(async () => ({ success: true }))
      }
    }) as unknown as ModuleDependencies,
    logStage: jest.fn(),
    stats: new StatsManager()
  };
}

describe('request executor Windsurf response protocol', () => {
  it('RED: /v1/responses submit through Windsurf must not bypass conversion as final chat.completion', async () => {
    mockConvertProviderResponseIfNeeded.mockClear();
    const handle = createWindsurfHandle(async () => ({
      status: 200,
      metadata: { responseSemantics: { continuation: { resumeFrom: { providerKey: 'windsurf.ws-pro-4.gpt-5.4-medium' } } } },
      data: {
        id: 'chatcmpl-windsurf-native-submit',
        object: 'chat.completion',
        model: 'gpt-5.4-medium',
        tool_outputs: [
          { tool_call_id: 'native:run_command:3', output: '/Users/fanzhang/Documents/github/routecodex\n' }
        ],
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Running `pwd` now.',
              tool_calls: [
                {
                  id: 'native:run_command:3',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}'
                  }
                }
              ]
            }
          }
        ]
      }
    }));

    const pipelineResult = {
      providerPayload: {
        model: 'gpt-5.4-medium',
        input: [
          {
            type: 'function_call_output',
            call_id: 'native:run_command:3',
            output: '/Users/fanzhang/Documents/github/routecodex\n'
          }
        ],
        stream: false
      },
      target: {
        providerKey: 'windsurf.ws-pro-4.gpt-5.4-medium',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'windsurf.ws-pro-4',
        processMode: 'standard',
        compatibilityProfile: 'chat:windsurf'
      },
      processMode: 'standard',
      routingDecision: { routeName: 'thinking' },
      metadata: {
        __rt: { clientProtocol: 'openai-responses' },
        capturedChatRequest: { model: 'gpt-5.4-medium', tools: [] },
        requestSemantics: { tools: { clientToolsRaw: [] } }
      }
    } as any;

    const pipeline: HubPipeline = {
      execute: jest.fn(async () => pipelineResult),
      updateVirtualRouterConfig: jest.fn()
    };

    const { HubRequestExecutor } = await import('../../../../../src/server/runtime/http-server/request-executor.js');
    const executor = new HubRequestExecutor(createDeps(handle, pipeline) as any);
    const result = await executor.execute({
      requestId: 'req-windsurf-submit-client-protocol',
      entryEndpoint: '/v1/responses/native-submit-response-1/submit_tool_outputs',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        tool_outputs: [
          {
            tool_call_id: 'native:run_command:3',
            output: '/Users/fanzhang/Documents/github/routecodex\n'
          }
        ],
        stream: false
      },
      metadata: { stream: false, inboundStream: false }
    } as PipelineExecutionInput);

    expect(mockConvertProviderResponseIfNeeded).toHaveBeenCalledTimes(1);
    expect(mockConvertProviderResponseIfNeeded.mock.calls[0]?.[0]).toMatchObject({
      providerProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses/native-submit-response-1/submit_tool_outputs'
    });
    expect(mockConvertProviderResponseIfNeeded.mock.calls[0]?.[0]?.pipelineMetadata?.responseSemantics).toMatchObject({
      continuation: { resumeFrom: { providerKey: 'windsurf.ws-pro-4.gpt-5.4-medium' } }
    });
    expect((result.body as any)?.object).toBe('response');
    expect((result.body as any)?.choices).toBeUndefined();
    expect((result.body as any)?.observed_provider_protocol).toBe('openai-responses');
  });

});
