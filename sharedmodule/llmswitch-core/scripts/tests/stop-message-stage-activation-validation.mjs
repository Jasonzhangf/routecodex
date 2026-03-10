import assert from 'node:assert';
import { VirtualRouterEngine } from '../../dist/router/virtual-router/engine.js';

function createEngine() {
  const engine = new VirtualRouterEngine();
  engine.initialize({
    routing: {
      default: [{ id: 'primary', targets: ['glm.1.glm-4.7'], priority: 1 }]
    },
    providers: {
      'glm.1.glm-4.7': {
        providerKey: 'glm.1.glm-4.7',
        providerType: 'openai',
        endpoint: 'http://localhost',
        auth: { type: 'apiKey', value: 'dummy' },
        outboundProfile: 'openai',
        modelId: 'glm-4.7'
      }
    },
    classifier: {}
  });
  return engine;
}

function createRequest(content) {
  return {
    model: 'glm-4.7',
    messages: [{ role: 'user', content }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions', sessionId: 'stop-stage-mode-session' }
  };
}

async function run() {
  const engine = createEngine();
  const request = createRequest('<**stopMessage:"继续执行",3**> test');
  const routed = engine.route(request, {
    requestId: 'req_mode_on_no_stage_templates',
    sessionId: 'stop-stage-mode-session',
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  });
  assert.strictEqual(routed.target.providerKey, 'glm.1.glm-4.7');

  const updatedRequest = createRequest('<**stopMessage:"继续执行",5,ai:on**> test');
  const routedAfterUpdate = engine.route(updatedRequest, {
    requestId: 'req_mode_on_reenable',
    sessionId: 'stop-stage-mode-session',
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  });
  assert.strictEqual(routedAfterUpdate.target.providerKey, 'glm.1.glm-4.7');

  console.log('✅ stop-message mode activation validation passed');
}

run();
