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

function buildStandardizedRequest(): StandardizedRequest {
  const messages: StandardizedMessage[] = [
    {
      role: 'user',
      content: '今天的国际新闻有哪些？'
    }
  ];
  return {
    model: 'gpt-test',
    messages,
    tools: [],
    parameters: {},
    metadata: {
      originalEndpoint: '/v1/chat/completions',
      webSearchEnabled: true
    }
  };
}

function buildMetadataInput(overrides?: Partial<RouterMetadataInput>): RouterMetadataInput {
  return {
    requestId: 'req-servertool-routing',
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    providerProtocol: 'openai-chat',
    stage: 'inbound',
    routeHint: 'default',
    ...(overrides || {})
  };
}

describe('VirtualRouterEngine servertool-aware provider selection', () => {
  function buildVirtualRouterEngine() {
    const input: VirtualRouterBootstrapInput = {
      virtualrouter: {
        providers: {
          primary: {
            id: 'primary',
            type: 'openai',
            endpoint: 'https://primary.invalid',
            serverToolsDisabled: true,
            auth: {
              type: 'apikey',
              apiKey: 'PRIMARY_KEY'
            },
            models: {
              'gpt-primary': {}
            }
          },
          secondary: {
            id: 'secondary',
            type: 'openai',
            endpoint: 'https://secondary.invalid',
            auth: {
              type: 'apikey',
              apiKey: 'SECONDARY_KEY'
            },
            models: {
              'gpt-secondary': {}
            }
          }
        },
        routing: {
          default: ['primary.gpt-primary', 'secondary.gpt-secondary']
        }
      }
    };

    const { config } = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);
    return engine;
  }

  test('skips providers with serverToolsDisabled when serverToolRequired=true', () => {
    const engine = buildVirtualRouterEngine();
    const request = buildStandardizedRequest();
    const metadata = buildMetadataInput({ serverToolRequired: true });

    const { target } = engine.route(request, metadata);

    expect(target.providerKey.startsWith('secondary.')).toBe(true);
  });

  test('allows providers with serverToolsDisabled when serverToolRequired is not set', () => {
    const engine = buildVirtualRouterEngine();
    const request = buildStandardizedRequest();
    const metadata = buildMetadataInput({ serverToolRequired: false });

    const { target } = engine.route(request, metadata);

    expect(target.providerKey.startsWith('primary.')).toBe(true);
  });
});
