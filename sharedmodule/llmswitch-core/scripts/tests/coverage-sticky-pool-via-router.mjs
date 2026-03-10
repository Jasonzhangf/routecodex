#!/usr/bin/env node

import assert from 'node:assert/strict';

function createRequest(content) {
  return {
    model: 'gpt-5.2',
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

async function main() {
  const { VirtualRouterEngine } = await import('../../dist/router/virtual-router/engine.js');
  const { bootstrapVirtualRouterConfig } = await import('../../dist/router/virtual-router/bootstrap.js');

  const blocked = new Set();
  const quotaView = (providerKey) => ({ inPool: !blocked.has(providerKey) });

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
            id: 'default:rr',
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

  // 1) prefer instruction with explicit alias should pin to that key (sticky pool selection path)
  {
    const sessionId = 'sess_prefer_alias';
    const r1 = engine.route(
      // Prefer is encoded as "!provider[alias].model" (routing-instructions contract).
      createRequest('<**!tab[key1].gpt-5.2**> hello'),
      createMetadata('req_prefer_alias_1', sessionId)
    );
    assert.equal(r1.target.providerKey, 'tab.key1.gpt-5.2');

    const r2 = engine.route(createRequest('followup'), createMetadata('req_prefer_alias_2', sessionId));
    assert.equal(r2.target.providerKey, 'tab.key1.gpt-5.2', 'prefer state should persist for the session');
  }

  // 2) prefer instruction without alias → allow alias rotation; quota blocks key1 so key2 should win
  {
    const sessionId = 'sess_prefer_rotate';
    blocked.add('tab.key1.gpt-5.2');
    const r = engine.route(
      // provider[].model means "all aliases for this provider+model", enabling alias rotation.
      createRequest('<**!tab[].gpt-5.2**> rotate'),
      createMetadata('req_prefer_rotate_1', sessionId)
    );
    assert.equal(r.target.providerKey, 'tab.key2.gpt-5.2');
    blocked.delete('tab.key1.gpt-5.2');
  }

  console.log('✅ coverage-sticky-pool-via-router passed');
}

main().catch((e) => {
  console.error('❌ coverage-sticky-pool-via-router failed:', e);
  process.exit(1);
});
