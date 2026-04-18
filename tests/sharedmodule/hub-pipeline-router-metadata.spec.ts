import { buildRouterMetadataInputWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-builders.js';
import { resolveStickyKey } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/keys.js';

describe('hub pipeline router metadata builder', () => {
  it('preserves followup routing directives required by virtual router', () => {
    const output = buildRouterMetadataInputWithNative({
      requestId: 'req-followup-router-meta',
      entryEndpoint: '/v1/responses',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-responses',
      metadata: {
        __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
        disabledProviderKeyAliases: ['qwen.1', 'qwen.2'],
        __rt: {
          disableStickyRoutes: true
        }
      }
    });

    expect(output).toMatchObject({
      requestId: 'req-followup-router-meta',
      __shadowCompareForcedProviderKey: 'ali-coding-plan.key1.kimi-k2.5',
      disabledProviderKeyAliases: ['qwen.1', 'qwen.2'],
      disableStickyRoutes: true
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
      },
      responsesResume: {
        previousRequestId: 'chain_from_semantics',
        restoredFromResponseId: 'resp_from_semantics'
      }
    });
    expect(resolveStickyKey(output as any)).toBe('chain_from_semantics');
  });
});
