import { describe, expect, it } from '@jest/globals';

import { runHubPipelineLibWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';

describe('hub pipeline Rust responses provider payload regression', () => {
  it('keeps /v1/responses tool requests as Responses wire payload for openai-responses providers', () => {
    const result = runHubPipelineLibWithNative({
      config: { virtualRouter: {} },
      request: {
        requestId: 'req_responses_tools_provider_payload',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: true,
        processMode: 'chat',
        direction: 'request',
        stage: '',
        payload: {
          model: 'gpt-5.5',
          stream: true,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'read files with a tool' }]
            }
          ],
          tools: [
            {
              type: 'function',
              name: 'exec_command',
              description: 'run a shell command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          ]
        },
        metadata: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          __routecodexPreselectedRoute: {
            target: {
              providerKey: 'minimonth.key1.MiniMax-M2.7',
              providerId: 'minimonth',
              modelId: 'MiniMax-M2.7',
              outboundProfile: 'openai-responses'
            },
            decision: { routeName: 'tools/gateway-priority-5555-weighted-tools' },
            diagnostics: {}
          }
        }
      }
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.payload).toMatchObject({
      model: 'MiniMax-M2.7',
      stream: true
    });
    expect(Array.isArray(result.payload?.input)).toBe(true);
    expect(result.payload).not.toHaveProperty('messages');
    expect(result.payload?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'exec_command' })
    ]));
  });
});
