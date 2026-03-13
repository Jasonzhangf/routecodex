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
          search: { value: 'dummy3' }
        }
      },
        models: [
          { id: 'text-1', capabilities: ['text'] },
          { id: 'vision-1', capabilities: ['vision'] },
          { id: 'search-1', capabilities: ['web_search'] }
        ]
      }
    },
    routing: {
      default: [
        {
          id: 'default:primary',
          priority: 100,
          mode: 'priority',
          targets: ['core.text.text-1', 'core.vision.vision-1', 'core.search.search-1']
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
      web_search: [
        {
          id: 'web_search:legacy',
          priority: 100,
          mode: 'priority',
          targets: ['core.text.text-1']
        }
      ]
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

console.log('✅ virtual-router capability routing tests passed');
