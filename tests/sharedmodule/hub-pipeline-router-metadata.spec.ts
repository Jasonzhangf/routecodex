import { resolveRoutingStateKey } from '../servertool/routing-instructions-direct-native.js';
import { buildRouterMetadataInputDirectNative } from './helpers/hub-pipeline-builders-direct-native.js';

describe('hub pipeline router metadata builder', () => {
  it('preserves followup routing directives required by virtual router', () => {
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-followup-router-meta',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      includeEstimatedInputTokens: true,
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-responses',
        },
      },
      metadata: {
        __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
        disabledProviderKeyAliases: ['provider-a.1', 'provider-a.2'],
        estimatedInputTokens: 123
      }
    });

    expect(output).toMatchObject({
      requestId: 'req-followup-router-meta',
      __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
      disabledProviderKeyAliases: ['provider-a.1', 'provider-a.2'],
      estimatedInputTokens: 123
    });
  });


  it('preserves provider-binding allowed provider keys for provider-mode relay', () => {
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-provider-relay-router-meta',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-chat',
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-chat',
        },
      },
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
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-cont-router-meta',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-chat',
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-chat',
        },
      },
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

  it('keeps responses relay continuation residue nested without promoting route truth to the top level', () => {
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-responses-relay-cont-router-meta',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-responses',
        },
      },
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

    expect(output).not.toHaveProperty('routeHint');
    expect(output).not.toHaveProperty('sessionId');
    expect(output).not.toHaveProperty('conversationId');
    expect(output).toMatchObject({
      continuation: {
        continuationOwner: 'relay',
        routeHint: 'search',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'stopless-live-123',
        conversationId: 'stopless-live-123'
      }
    });
  });

  it('does not revive retryProviderKey from legacy __rt residue without runtime_control', () => {
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-legacy-rt-retry-provider-key',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-responses',
        },
      },
      metadata: {
        __rt: {
          retryProviderKey: 'legacy.provider.gpt-5.5'
        }
      }
    });

    expect(output.retryProviderKey).toBeUndefined();
  });

  it('prefers metadataCenterSnapshot runtimeControl.routeHint over flat routeHint and resume residue', () => {
    const output = buildRouterMetadataInputDirectNative({
      requestId: 'req-snapshot-route-hint',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      routeHint: 'payload-search',
      metadataCenterSnapshot: {
        runtimeControl: {
          providerProtocol: 'openai-responses',
          routeHint: 'snapshot-search',
        }
      },
      metadata: {
        responsesResume: {
          routeHint: 'resume-search'
        }
      }
    });

    expect(output.routeHint).toBe('snapshot-search');
  });
});
