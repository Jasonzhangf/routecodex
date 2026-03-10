import assert from 'node:assert/strict';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import { bootstrapVirtualRouterConfig } from '../../dist/router/virtual-router/bootstrap.js';
import { VirtualRouterError } from '../../dist/router/virtual-router/types.js';

function createRequest(content, model) {
  return {
    model,
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function createMetadata(requestId, sessionId) {
  return {
    requestId,
    ...(sessionId ? { sessionId } : {}),
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

console.log('🧪 virtual-router direct model tests...');

const blocked = new Set();
const quotaView = (providerKey) => ({ inPool: !blocked.has(providerKey) });

{
  const input = {
    virtualrouter: {
      providers: {
        tab: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'dummy1' },
              key2: { value: 'dummy2' }
            }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:p0',
            priority: 100,
            mode: 'round-robin',
            targets: ['tab.key1.gpt-5.2', 'tab.key2.gpt-5.2']
          }
        ]
      },
      loadBalancing: { strategy: 'sticky' },
      classifier: {}
    }
  };

  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine({ quotaView });
  engine.initialize(config);

  const sessionId = 'direct_session';
  const a = engine.route(createRequest('a', 'tab.gpt-5.2'), createMetadata('req_direct_1', sessionId));
  const b = engine.route(createRequest('b', 'tab.gpt-5.2'), createMetadata('req_direct_2', sessionId));
  const c = engine.route(createRequest('c', 'tab.gpt-5.2'), createMetadata('req_direct_3', sessionId));
  assert.equal(a.decision.routeName, 'direct');
  assert.equal(b.decision.routeName, 'direct');
  assert.equal(c.decision.routeName, 'direct');
  assert.equal(a.target.providerKey, 'tab.key1.gpt-5.2');
  assert.equal(b.target.providerKey, 'tab.key2.gpt-5.2');
  assert.equal(c.target.providerKey, 'tab.key1.gpt-5.2');

  blocked.add('tab.key1.gpt-5.2');
  const d = engine.route(createRequest('d', 'tab.gpt-5.2'), createMetadata('req_direct_4', sessionId));
  assert.equal(d.target.providerKey, 'tab.key2.gpt-5.2');
  blocked.delete('tab.key1.gpt-5.2');

  assert.throws(
    () => engine.route(createRequest('x', 'tab.nonexistent-model'), createMetadata('req_direct_bad', sessionId)),
    (error) => error instanceof VirtualRouterError,
    'unknown provider.model should throw VirtualRouterError'
  );
}

{
  const input = {
    virtualrouter: {
      providers: {
        lmstudio: {
          type: 'responses',
          endpoint: 'http://127.0.0.1:5555/v1',
          auth: {
            type: 'apikey',
            apiKey: ''
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['lmstudio.gpt-oss-20b-mlx']
          }
        ]
      }
    }
  };

  assert.doesNotThrow(
    () => bootstrapVirtualRouterConfig(input),
    'explicit apikey auth with empty apiKey should be treated as intentional no-auth config'
  );
}

console.log('✅ virtual-router direct model tests passed');
