import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type {
  RouterMetadataInput,
  VirtualRouterBootstrapInput
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import type {
  StandardizedMessage,
  StandardizedRequest
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

function buildEngine(): VirtualRouterEngine {
  const input: VirtualRouterBootstrapInput = {
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              sonnetkey: { value: 'SONNET' },
              sonnetbackup: { value: 'SONNET-BACKUP' },
              geminikey: { value: 'GEMINI' }
            }
          },
          models: {
            'claude-sonnet-4-5': {},
            'gemini-3-pro-high': {}
          }
        }
      },
      routing: {
        default: [
          'antigravity.claude-sonnet-4-5',
          'antigravity.geminikey.gemini-3-pro-high'
        ]
      }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function buildRequest(userContent: string): StandardizedRequest {
  const messages: StandardizedMessage[] = [
    {
      role: 'user',
      content: userContent
    }
  ];
  return {
    model: 'dummy',
    messages,
    tools: [],
    parameters: {},
    metadata: {
      originalEndpoint: '/v1/chat/completions',
      webSearchEnabled: false
    }
  };
}

function buildMetadata(overrides?: Partial<RouterMetadataInput>): RouterMetadataInput {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    providerProtocol: 'openai-chat',
    stage: 'inbound',
    routeHint: 'default',
    ...(overrides ?? {})
  };
}

describe('VirtualRouterEngine routing instructions', () => {
  test('sticky instructions honor provider.model syntax', () => {
    const engine = buildEngine();
    const request = buildRequest('<**!antigravity.gemini-3-pro-high**>');
    const { target } = engine.route(request, buildMetadata({ sessionId: 'session-sticky-model' }));
    expect(target.providerKey.includes('gemini-3-pro-high')).toBe(true);
  });

  test('disabling provider model only removes that model for the session', () => {
    const engine = buildEngine();
    const sessionId = 'session-disable-model';
    engine.route(buildRequest('<**#antigravity.claude-sonnet-4-5**>'), buildMetadata({ sessionId }));

    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('gemini-3-pro-high')).toBe(true);
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(false);
  });

  test('disabling provider key alias respects provider.key syntax', () => {
    const engine = buildEngine();
    const sessionId = 'session-disable-key';
    engine.route(buildRequest('<**#antigravity.geminikey**>'), buildMetadata({ sessionId }));

    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(followUp.target.providerKey.includes('gemini-3-pro-high')).toBe(false);
  });

  test('sticky provider.model instructions retain all aliases for retries', () => {
    const engine = buildEngine();
    const sessionId = 'session-sticky-multi-key';
    const first = engine.route(
      buildRequest('<**!antigravity.claude-sonnet-4-5**>'),
      buildMetadata({ sessionId })
    );
    expect(first.target.providerKey.includes('sonnetkey')).toBe(true);

    engine.route(buildRequest('<**#antigravity.sonnetkey**>'), buildMetadata({ sessionId }));
    const followUp = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(followUp.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(followUp.target.providerKey.includes('sonnetbackup')).toBe(true);
  });

  test('sticky provider.model rotates between aliases without additional instructions', () => {
    const engine = buildEngine();
    const sessionId = 'session-round-robin-multi-key';
    const first = engine.route(
      buildRequest('<**!antigravity.claude-sonnet-4-5**>'),
      buildMetadata({ sessionId })
    );
    expect(first.target.providerKey.includes('sonnetkey')).toBe(true);

    const second = engine.route(buildRequest('继续'), buildMetadata({ sessionId }));
    expect(second.target.providerKey.includes('claude-sonnet-4-5')).toBe(true);
    expect(second.target.providerKey).not.toBe(first.target.providerKey);
  });
});
