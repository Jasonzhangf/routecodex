import { buildRouterMetadataInputWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-builders.js';
import { resolveRoutingStateKey } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';

describe('hub pipeline router metadata builder', () => {
  it('preserves followup routing directives required by virtual router', () => {
    const output = buildRouterMetadataInputWithNative({
      requestId: 'req-followup-router-meta',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      includeEstimatedInputTokens: true,
      metadata: {
        __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
        disabledProviderKeyAliases: ['qwen.1', 'qwen.2'],
        estimatedInputTokens: 123
      }
    });

    expect(output).toMatchObject({
      requestId: 'req-followup-router-meta',
      __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
      disabledProviderKeyAliases: ['qwen.1', 'qwen.2'],
      estimatedInputTokens: 123
    });
  });


  it('preserves provider-binding allowed provider keys for provider-mode relay', () => {
    const output = buildRouterMetadataInputWithNative({
      requestId: 'req-provider-relay-router-meta',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-chat',
      metadata: {
        routecodexPortMode: 'provider',
        routecodexPortBinding: 'anthropic.claude',
        routecodexProviderRelayBinding: 'anthropic.claude',
        routecodexProviderRelayProtocol: 'anthropic-messages',
        allowedProviders: ['anthropic.claude'],
      },
    });

    expect(output).toMatchObject({
      routecodexPortMode: 'provider',
      routecodexPortBinding: 'anthropic.claude',
      allowedProviders: ['anthropic.claude'],
    });
  });

  it('hydrates router continuation from request semantics and routes by unified request-chain key', () => {
    const output = buildRouterMetadataInputWithNative({
      requestId: 'req-cont-router-meta',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-chat',
      sessionId: 'session-should-not-win',
      requestSemantics: {
        continuation: {
          chainId: 'chain_from_semantics',
          stickyScope: 'request_chain',
          resumeFrom: {
            requestId: 'chain_from_semantics',
            protocol: 'openai-responses'
          }
        },
        responses: {
          resume: {
            previousRequestId: 'chain_from_semantics',
            restoredFromResponseId: 'resp_from_semantics'
          }
        }
      }
    });

    expect(output).toMatchObject({
      continuation: {
        chainId: 'chain_from_semantics',
        stickyScope: 'request_chain',
        resumeFrom: {
          requestId: 'chain_from_semantics'
        }
      }
    });
    expect(output).not.toHaveProperty('responsesResume');
    expect(resolveRoutingStateKey(output as any)).toBe('chain_from_semantics');
  });

  it('preserves responses relay continuation scope fields from request semantics for resumed submit_tool_outputs', () => {
    const output = buildRouterMetadataInputWithNative({
      requestId: 'req-responses-relay-cont-router-meta',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      requestSemantics: {
        continuation: {
          chainId: 'req_prev_1',
          continuationOwner: 'relay',
          routeHint: 'search',
          providerKey: 'minimonth.key1.MiniMax-M2.7',
          sessionId: 'stopless-live-123',
          conversationId: 'stopless-live-123',
          resumeFrom: {
            requestId: 'req_prev_1',
            responseId: 'resp_prev_1',
            protocol: 'openai-responses'
          },
          toolContinuation: {
            mode: 'submit_tool_outputs',
            submittedToolCallIds: ['call_1'],
            resumeOutputs: ['{}']
          }
        },
        responses: {
          resume: {
            previousRequestId: 'req_prev_1',
            restoredFromResponseId: 'resp_prev_1'
          }
        }
      }
    });

    expect(output).toMatchObject({
      routeHint: 'search',
      sessionId: 'stopless-live-123',
      conversationId: 'stopless-live-123',
      continuation: {
        continuationOwner: 'relay',
        routeHint: 'search',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'stopless-live-123',
        conversationId: 'stopless-live-123'
      }
    });
  });
});
