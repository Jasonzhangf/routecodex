import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';
import assert from 'assert';

function createRequest(content) {
  return {
    model: 'glm-4.7',
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

function runTests() {
  console.log('🧪 Starting Routing Instructions Tests...');
  
  const engine = new VirtualRouterEngine();
  engine.initialize({
    routing: {
      default: [
        { id: 'primary', targets: ['glm.1.glm-4.7', 'openai.1.gpt-4'], priority: 1 }
      ]
    },
    providers: {
      'glm.1.glm-4.7': {
        providerKey: 'glm.1.glm-4.7',
        providerType: 'openai',
        endpoint: 'http://localhost',
        auth: { type: 'apiKey', value: 'dummy' },
        outboundProfile: 'openai',
        modelId: 'glm-4.7'
      },
      'openai.1.gpt-4': {
        providerKey: 'openai.1.gpt-4',
        providerType: 'openai',
        endpoint: 'http://localhost',
        auth: { type: 'apiKey', value: 'dummy' },
        outboundProfile: 'openai',
        modelId: 'gpt-4'
      }
    },
    classifier: {}
  });

  try {
    // Test 1: Force single request
    console.log('Test 1: Force single request with <**provider.model**>');
    const request1 = createRequest('<**glm.glm-4.7**> test');
    const result1 = engine.route(request1, {
      requestId: 'req1',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    assert.strictEqual(result1.target.providerKey, 'glm.1.glm-4.7');
    assert.strictEqual(request1.messages[0].content, 'test');
    console.log('✅ Test 1 Passed');

    // Test 2: Filter allowed provider
    console.log('Test 2: Filter allowed provider with <**!provider**>');
    const request2 = createRequest('<**!glm**> test');
    const result2 = engine.route(request2, {
      requestId: 'req2',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    assert.strictEqual(result2.target.providerKey, 'glm.1.glm-4.7');
    console.log('✅ Test 2 Passed');

    // Test 3: Disable provider
    console.log('Test 3: Disable provider with <**#provider**>');
    const request3 = createRequest('<**#glm**> test');
    // Assuming openai is selected when glm is disabled
    const result3 = engine.route(request3, {
      requestId: 'req3',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    assert.strictEqual(result3.target.providerKey, 'openai.1.gpt-4');
    console.log('✅ Test 3 Passed');

    // Test 4: Disable provider key by index (Note: we need to setup a case where this matters, or verify failure if all targets disabled)
    // For this test, let's disable openai key 1, so if glm is also disabled (or if we force openai), it should fail or pick another
    // But here we only have 1 key per provider.
    // Let's try disabling 'openai.1' and see if it picks 'glm' (which is default)
    console.log('Test 4: Disable provider key by index <**#openai.1**>');
    const request4 = createRequest('<**#openai.1**> test');
    const result4 = engine.route(request4, {
      requestId: 'req4',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    // Should still pick glm or openai if openai has other keys (it doesn't). 
    // In our config, default pool has glm and openai. 
    // Disabling openai.1 means openai.1.gpt-4 is disabled. 
    // So only glm.1.glm-4.7 remains.
    assert.strictEqual(result4.target.providerKey, 'glm.1.glm-4.7'); 
    console.log('✅ Test 4 Passed');

    // Test 5: Verify sticky behavior with clean message
    console.log('Test 5: Sticky behavior');
    // First request sets sticky
    const request5a = createRequest('<**!openai**> test sticky');
    const result5a = engine.route(request5a, {
      requestId: 'req5a',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    assert.strictEqual(result5a.target.providerKey, 'openai.1.gpt-4');
    
    // Second request (same requestId or session simulation?) 
    // VirtualRouterEngine stores sticky state by stickyKey (default requestId).
    // If we use same requestId, state is preserved.
    const request5b = createRequest('follow up');
    const result5b = engine.route(request5b, {
      requestId: 'req5a', // Reusing ID to simulate same session/sticky key if applicable
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
    assert.strictEqual(result5b.target.providerKey, 'openai.1.gpt-4');
    console.log('✅ Test 5 Passed');

    console.log('🎉 All Routing Instructions Tests Passed!');
  } catch (err) {
    console.error('❌ Test Failed:', err);
    process.exit(1);
  }
}

runTests();
