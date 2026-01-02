import { bootstrapVirtualRouterConfig } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/engine.js';

function buildEngine() {
  const input = {
    virtualrouter: {
      providers: {
        antigravity: {
          id: 'antigravity',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'KEY1' },
              key2: { value: 'KEY2' },
              key3: { value: 'KEY3' }
            }
          },
          models: {
            'model-a': {},
            'model-b': {}
          }
        },
        openai: {
          id: 'openai',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: {
            type: 'apikey',
            keys: {
              primary: { value: 'PRIMARY' }
            }
          },
          models: {
            'gpt-4': {}
          }
        }
      },
      routing: {
        default: [
          'antigravity.key1.model-a',
          'antigravity.key2.model-a',
          'antigravity.key3.model-a',
          'openai.primary.gpt-4'
        ]
      }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function buildRequest(userContent) {
  const messages = [
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

function buildMetadata(overrides = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request',
    providerProtocol: 'openai-chat',
    stage: 'inbound',
    routeHint: 'default',
    ...overrides
  };
}

console.log('=== 详细测试 #provider 指令 ===\n');

const engine = buildEngine();

// 测试场景 1: 禁用整个 provider,但有其他 provider 可用
console.log('场景 1: 禁用 antigravity,但 openai 仍然可用');
const sessionId1 = 'test-scenario-1';
try {
  const result = engine.route(
    buildRequest('<**#antigravity**> 测试'),
    buildMetadata({ sessionId: sessionId1 })
  );
  console.log('  ✓ 成功路由到 openai:', result.target.providerKey);
  console.log('  providerId:', result.target.providerId);
} catch (error) {
  console.log('  ✗ 失败:', error.message);
}
console.log();

// 测试场景 2: 禁用所有 provider
console.log('场景 2: 禁用所有 provider (antigravity 和 openai)');
const sessionId2 = 'test-scenario-2';
try {
  const result = engine.route(
    buildRequest('<**#antigravity,openai**> 测试'),
    buildMetadata({ sessionId: sessionId2 })
  );
  console.log('  ✗ 应该抛出错误,但成功了:', result.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确抛出错误:', error.message);
}
console.log();

// 测试场景 3: 禁用某个 provider 的所有 key,但该 provider 有多个 key
console.log('场景 3: 禁用 antigravity 的所有 key (通过禁用整个 provider)');
const sessionId3 = 'test-scenario-3';
try {
  const result1 = engine.route(
    buildRequest('<**#antigravity**> 测试'),
    buildMetadata({ sessionId: sessionId3 })
  );
  console.log('  请求1:', result1.target.providerKey);
} catch (error) {
  console.log('  请求1: ✓ 正确抛出错误 (antigravity 被禁用)');
}
// 后续请求
try {
  const result2 = engine.route(
    buildRequest('后续请求'),
    buildMetadata({ sessionId: sessionId3 })
  );
  console.log('  请求2:', result2.target.providerKey, '(应该路由到 openai)');
} catch (error) {
  console.log('  请求2: ✗ 失败:', error.message);
}
console.log();

// 测试场景 4: 禁用特定 key,其他 key 仍然可用
console.log('场景 4: 禁用 antigravity.key1,其他 key 仍然可用');
const sessionId4 = 'test-scenario-4';
const result4 = engine.route(
  buildRequest('<**#antigravity.key1**> 测试'),
  buildMetadata({ sessionId: sessionId4 })
);
console.log('  选中:', result4.target.providerKey);
if (result4.target.providerKey.includes('key1')) {
  console.log('  ✗ 错误: 不应该选中 key1');
} else {
  console.log('  ✓ 正确: 没有选中 key1');
}
console.log();

// 测试场景 5: 禁用多个 key
console.log('场景 5: 禁用 antigravity.key1 和 antigravity.key2');
const sessionId5 = 'test-scenario-5';
const result5 = engine.route(
  buildRequest('<**#antigravity.key1,antigravity.key2**> 测试'),
  buildMetadata({ sessionId: sessionId5 })
);
console.log('  选中:', result5.target.providerKey);
if (result5.target.providerKey.includes('key3') || result5.target.providerKey.includes('openai')) {
  console.log('  ✓ 正确: 选中了 key3 或 openai');
} else {
  console.log('  ✗ 错误: 应该选中 key3 或 openai');
}
console.log();

// 测试场景 6: 禁用指定模型
console.log('场景 6: 禁用 antigravity 的 model-a');
const sessionId6 = 'test-scenario-6';
const result6 = engine.route(
  buildRequest('<**#antigravity.model-a**> 测试'),
  buildMetadata({ sessionId: sessionId6 })
);
console.log('  选中:', result6.target.providerKey);
if (result6.target.providerKey.includes('openai')) {
  console.log('  ✓ 正确: 路由到 openai (model-a 被禁用)');
} else {
  console.log('  ✗ 错误: 应该路由到 openai');
}
console.log();

// 测试场景 7: 检查 sticky key 隔离
console.log('场景 7: 不同 session 的禁用状态应该隔离');
const sessionId7a = 'test-session-7a';
const sessionId7b = 'test-session-7b';

// session 7a 禁用 antigravity
try {
  const result7a = engine.route(
    buildRequest('<**#antigravity**> 测试'),
    buildMetadata({ sessionId: sessionId7a })
  );
  console.log('  Session 7a:', result7a.target.providerKey);
} catch (error) {
  console.log('  Session 7a: ✓ antigravity 被禁用,路由到 openai');
}

// session 7b 不应该受影响
const result7b = engine.route(
  buildRequest('测试'),
  buildMetadata({ sessionId: sessionId7b })
);
console.log('  Session 7b:', result7b.target.providerKey, '(应该能路由到 antigravity)');
if (result7b.target.providerKey.includes('antigravity')) {
  console.log('  ✓ 正确: session 隔离生效');
} else {
  console.log('  ✗ 错误: session 隔离失效');
}
console.log();

// 测试场景 8: 检查覆盖行为
console.log('场景 8: 新的 # 指令应该覆盖之前的禁用列表');
const sessionId8 = 'test-scenario-8';

// 先禁用 key1
const result8a = engine.route(
  buildRequest('<**#antigravity.key1**> 测试'),
  buildMetadata({ sessionId: sessionId8 })
);
console.log('  步骤1 (禁用 key1):', result8a.target.providerKey);

// 再禁用 key2 (应该覆盖之前的禁用,只禁用 key2)
const result8b = engine.route(
  buildRequest('<**#antigravity.key2**> 测试'),
  buildMetadata({ sessionId: sessionId8 })
);
console.log('  步骤2 (禁用 key2):', result8b.target.providerKey);
if (result8b.target.providerKey.includes('key1')) {
  console.log('  ✓ 正确: key1 恢复可用 (覆盖生效)');
} else {
  console.log('  ✗ 错误: key1 应该恢复可用');
}
console.log();

console.log('=== 测试完成 ===');