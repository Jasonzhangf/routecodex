import { describe, expect, it } from '@jest/globals';

import { resolveProviderRequestContext } from '../../../../../src/server/runtime/http-server/executor/provider-request-context.js';

describe('resolveProviderRequestContext', () => {
  it('prefers runtime handle protocol over routed target outboundProfile when they conflict', () => {
    const result = resolveProviderRequestContext({
      providerRequestId: 'req-provider-ctx-1',
      entryEndpoint: '/v1/responses',
      target: {
        providerKey: 'crs.crsa.gpt-5.3-codex',
        outboundProfile: 'openai-responses'
      },
      handle: {
        providerProtocol: 'openai-chat',
        providerId: 'crs'
      } as any,
      runtimeKey: 'crs.crsa',
      providerPayload: {
        model: 'gpt-5.3-codex'
      },
      mergedMetadata: {}
    });

    expect(result.providerProtocol).toBe('openai-chat');
  });

  it('keeps runtime chat protocol for real responses-entry snapshot shape carrying previous_response_id', () => {
    const result = resolveProviderRequestContext({
      providerRequestId: 'req-provider-ctx-real-shape',
      entryEndpoint: '/v1/responses',
      target: {
        providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
        outboundProfile: 'openai-responses'
      },
      handle: {
        providerProtocol: 'openai-chat',
        providerId: 'dbittai-gpt'
      } as any,
      runtimeKey: 'dbittai-gpt.key1',
      providerPayload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            role: 'user',
            type: 'message',
            content: [{ type: 'input_text', text: 'Continue working toward the active thread goal.' }]
          }
        ],
        previous_response_id: 'resp_08812fd8ef32c8b7016a0cf20910e08196be397bbe9057415a',
        stream: true,
        store: false
      },
      mergedMetadata: {
        target: {
          clientModelId: 'gpt-5.3-codex'
        }
      }
    });

    expect(result.providerProtocol).toBe('openai-chat');
    expect(result.providerModel).toBe('gpt-5.3-codex');
    expect(typeof result.requestId).toBe('string');
    expect(result.requestId.length).toBeGreaterThan(0);
  });
});
