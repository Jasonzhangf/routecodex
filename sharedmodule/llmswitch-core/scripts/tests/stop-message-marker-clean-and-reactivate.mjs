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

function routeRequest(engine, request, requestId) {
  const sessionId = 'stop-message-regression-session';
  const tmuxSessionId = 'stop-message-regression-tmux';
  return engine.route(request, {
    requestId,
    sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  });
}

function hasMarker(messages) {
  return messages.some((message) => {
    if (!message || message.role !== 'user' || typeof message.content !== 'string') {
      return false;
    }
    return message.content.includes('<**');
  });
}

async function run() {
  const engine = createEngine();
  const sessionId = 'stop-message-regression-session';
  const tmuxSessionId = 'stop-message-regression-tmux';

  routeRequest(
    engine,
    {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: '<**stopMessage:"继续执行",3**> activate' }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
    },
    'req_mode_activate'
  );

  routeRequest(
    engine,
    {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: '<**stopMessage:"继续执行",3**> resume' }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
    },
    'req_rearm'
  );

  const state = engine.getStopMessageState({
    requestId: 'snapshot',
    sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    entryEndpoint: '/v1/chat/completions'
  });
  assert.ok(state, 'stopMessage state should exist after explicit set');
  assert.strictEqual(state?.stopMessageStageMode, 'on', 'set after off should re-arm mode');

  routeRequest(
    engine,
    {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: '<**stopMessage:"必须完全rust化",ai:on,20**> 继续执行' }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
    },
    'req_ai_on_tail'
  );

  const aiOnState = engine.getStopMessageState({
    requestId: 'snapshot_ai_on_tail',
    sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    entryEndpoint: '/v1/chat/completions'
  });
  assert.ok(aiOnState, 'stopMessage state should exist after ai:on tail set');
  assert.strictEqual(aiOnState?.stopMessageText, '必须完全rust化', 'stopMessage text should update from latest user');
  assert.strictEqual(aiOnState?.stopMessageMaxRepeats, 20, 'stopMessage max repeats should parse from tail tokens');
  assert.strictEqual(aiOnState?.stopMessageAiMode, 'on', 'stopMessage ai mode should parse from tail tokens');

  const responsesContextRequest = {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: '继续执行' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/responses', sessionId, tmuxSessionId },
    semantics: {
      responses: {
        context: {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: '<**stopMessage:\"响应上下文\",ai:on,5**> 继续执行'
                }
              ]
            }
          ]
        }
      }
    }
  };
  routeRequest(engine, responsesContextRequest, 'req_responses_context');
  const responsesContextState = engine.getStopMessageState({
    requestId: 'snapshot_responses_context',
    sessionId,
    clientTmuxSessionId: tmuxSessionId,
    tmuxSessionId,
    entryEndpoint: '/v1/responses'
  });
  assert.ok(responsesContextState, 'stopMessage state should exist after responses context set');
  assert.strictEqual(responsesContextState?.stopMessageText, '响应上下文', 'stopMessage text should parse from responses context');
  assert.strictEqual(responsesContextState?.stopMessageMaxRepeats, 5, 'stopMessage max repeats should parse from responses context');
  assert.strictEqual(responsesContextState?.stopMessageAiMode, 'on', 'stopMessage ai mode should parse from responses context');
  const responsesContextInput = responsesContextRequest.semantics.responses.context.input;
  const responsesContextText = JSON.stringify(responsesContextInput);
  assert.ok(!responsesContextText.includes('<**'), 'responses context markers should be stripped from forwarded input');

  const replayedHistoryRequest = {
    model: 'glm-4.7',
    messages: [
      { role: 'user', content: '<**stopMessage:"继续执行",3**> 继续执行' },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '请继续下一步' }
    ],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
  };

  routeRequest(engine, replayedHistoryRequest, 'req_marker_cleanup');
  assert.ok(!hasMarker(replayedHistoryRequest.messages), 'routing instruction markers should be stripped from forwarded messages');

  const wildcardMarkerRequest = {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: '<****> 请继续执行' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions', sessionId, tmuxSessionId }
  };
  routeRequest(engine, wildcardMarkerRequest, 'req_marker_cleanup_wildcard');
  assert.ok(!hasMarker(wildcardMarkerRequest.messages), 'wildcard marker block should be stripped from forwarded messages');

  console.log('✅ stop-message marker clean + rearm regression checks passed');
}

run();
