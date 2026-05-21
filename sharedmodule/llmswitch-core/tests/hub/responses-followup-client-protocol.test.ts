import { describe, expect, test } from '@jest/globals';
import { resolveProviderResponseContextSignals } from '../../src/conversion/hub/response/provider-response-helpers.js';
import { convertProviderResponse } from '../../src/conversion/hub/response/provider-response.js';

describe('responses client protocol on followup', () => {
  test('keeps /v1/responses mapped to openai-responses even when serverToolFollowup is set', () => {
    const signals = resolveProviderResponseContextSignals(
      {
        requestId: 'req_followup_resp',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        __rt: {
          serverToolFollowup: true
        }
      } as any,
      '/v1/responses'
    );

    expect(signals.clientProtocol).toBe('openai-responses');
  });

  test('still remaps tool-calls to response object for /v1/responses on followup-marked context', async () => {
    const converted = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_followup_surface',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4-medium',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_followup_surface_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      } as any,
      context: {
        requestId: 'req_followup_surface',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        __rt: {
          serverToolFollowup: true
        }
      } as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(converted.body?.object).toBe('response');
    expect(converted.body?.status).toBe('requires_action');
    expect(converted.body?.output?.[0]?.type).toBe('function_call');
  });
});
