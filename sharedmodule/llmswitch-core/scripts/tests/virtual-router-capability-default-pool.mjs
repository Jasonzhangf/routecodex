import assert from 'node:assert/strict';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import { bootstrapVirtualRouterConfig } from '../../dist/router/virtual-router/bootstrap.js';

function createRequest({ content, tools }) {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    ...(tools ? { tools } : {}),
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function createMetadata(requestId) {
  return {
    requestId,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

console.log('🧪 virtual-router capability routing (default pool) tests...');

const input = {
  virtualrouter: {
    providers: {
      core: {
        type: 'openai',
        endpoint: 'http://localhost',
      auth: {
        type: 'apikey',
        keys: {
          text: { value: 'dummy1' },
          vision: { value: 'dummy2' },
          search: { value: 'dummy3' },
          search2: { value: 'dummy4' }
        }
      },
        models: {
          'text-1': { capabilities: ['text'] },
          'vision-1': { capabilities: ['vision'] },
          'search-1': { capabilities: ['web_search'] },
          'search-2': { capabilities: ['web_search'] }
        }
      }
    },
    routing: {
      default: [
        {
          id: 'default:primary',
          priority: 100,
          loadBalancing: {
            strategy: 'weighted',
            weights: {
              'core.search-1': 3,
              'core.search-2': 1,
              'core.text-1': 20,
              'core.vision-1': 20
            }
          },
          targets: ['core.text.text-1', 'core.vision.vision-1', 'core.search.search-1', 'core.search2.search-2']
        }
      ],
      multimodal: [
        {
          id: 'multimodal:legacy',
          priority: 100,
          mode: 'priority',
          targets: ['core.text.text-1']
        }
      ],
      vision: [
        {
          id: 'vision:legacy',
          priority: 100,
          mode: 'priority',
          targets: ['core.text.text-1']
        }
      ],
    }
  }
};

const { config } = bootstrapVirtualRouterConfig(input);
const engine = new VirtualRouterEngine({
  quotaView: () => ({ inPool: true })
});
engine.initialize(config);

{
  const request = createRequest({
    content: [
      { type: 'input_text', text: 'describe this image' },
      { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
    ]
  });
  const decision = engine.route(request, createMetadata('req_capability_image'));
  assert.equal(
    decision.target.providerKey,
    'core.vision.vision-1',
    'image requests must route to vision-capable model from default pool'
  );
}

{
  const request = createRequest({
    content: [{ type: 'input_text', text: 'search the web for today news' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'search the web'
        }
      }
    ]
  });
  const decision = engine.route(request, createMetadata('req_capability_web_search'));
  assert.equal(
    decision.target.providerKey,
    'core.search.search-1',
    'web_search requests must route to web_search-capable model from default pool'
  );
}

{
  const weightedSequence = [];
  for (let i = 0; i < 4; i += 1) {
    const request = createRequest({
      content: [{ type: 'input_text', text: `search the web for latest news ${i}` }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search the web'
          }
        }
      ]
    });
    const decision = engine.route(request, createMetadata(`req_capability_web_search_weighted_${i}`));
    weightedSequence.push(decision.target.providerKey);
  }
  assert.deepEqual(
    weightedSequence,
    [
      'core.search.search-1',
      'core.search2.search-2',
      'core.search.search-1',
      'core.search.search-1',
    ],
    'default-pool web_search fallback must keep weighted load balancing inside web_search-capable targets only'
  );
}

{
  const explicitRouteInput = {
    virtualrouter: {
      providers: {
        explicit: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          },
          models: {
            'general-1': {},
            'search-1': { capabilities: ['web_search'] }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:primary',
            priority: 100,
            targets: ['explicit.key1.search-1']
          }
        ],
        web_search: [
          {
            id: 'web_search:explicit',
            priority: 100,
            targets: ['explicit.key2.general-1']
          }
        ]
      }
    }
  };

  const { config: explicitConfig } = bootstrapVirtualRouterConfig(explicitRouteInput);
  const explicitEngine = new VirtualRouterEngine({
    quotaView: () => ({ inPool: true })
  });
  explicitEngine.initialize(explicitConfig);

  const request = createRequest({
    content: [{ type: 'input_text', text: 'search the web for explicit-route result' }]
  });
  const decision = explicitEngine.route(request, createMetadata('req_capability_web_search_explicit_route'));
  assert.equal(
    decision.target.providerKey,
    'explicit.key2.general-1',
    'explicit web_search route must win before default-pool capability fallback'
  );
}

console.log('✅ virtual-router capability routing tests passed');
