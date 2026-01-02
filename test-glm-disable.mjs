import { bootstrapVirtualRouterConfig } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/engine.js';

// 模拟你的配置
function buildEngine() {
  const input = {
    virtualrouter: {
      providers: {
        glm: {
          id: 'glm',
          type: 'openai',
          endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'KEY1' }
            }
          },
          models: {
            'glm-4.7': {}
          }
        },
        openai: {
          id: 'openai',
          type: 'openai',
          endpoint: 'https://api.openai.com/v1',
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
          'glm.glm-4.7'
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

console.log('=== 测试 <**#glm**> 禁用场景 ===\n');

const engine = buildEngine();
const sessionId = 'test-glm-disable';

// 场景 1: 只有 glm provider,禁用 glm 后应该失败
console.log('场景 1: 只有 glm provider,禁用 glm');
try {
  const result = engine.route(
    buildRequest('<**#glm**> 测试'),
    buildMetadata({ sessionId })
  );
  console.log('  ✗ 错误: 应该抛出错误,但成功了:', result.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确抛出错误:', error.message);
  console.log('  原因: 所有 provider 都被禁用了');
}
console.log();

// 场景 2: 检查配置中 provider ID 是否正确
console.log('场景 2: 检查配置');
const status = engine.getStatus();
console.log('  可用的路由:');
for (const [routeName, routeInfo] of Object.entries(status.routes)) {
  console.log(`    ${routeName}:`, routeInfo.providers);
}
console.log();

// 场景 3: 正常请求(无禁用)
console.log('场景 3: 正常请求(无禁用)');
try {
  const result = engine.route(
    buildRequest('测试'),
    buildMetadata({ sessionId: 'test-normal' })
  );
  console.log('  ✓ 成功路由到:', result.target.providerKey);
  console.log('  providerId:', result.target.providerId || '(未设置)');
} catch (error) {
  console.log('  ✗ 失败:', error.message);
}
console.log();

// 场景 4: 测试使用错误的 provider ID
console.log('场景 4: 使用错误的 provider ID (比如 "glm-provider")');
try {
  const result = engine.route(
    buildRequest('<**#glm-provider**> 测试'),
    buildMetadata({ sessionId: 'test-wrong-id' })
  );
  console.log('  结果:', result.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确: provider ID 不匹配,但请求继续:', error.message);
}
console.log();

console.log('=== 测试完成 ===');
console.log('\n💡 建议:');
console.log('1. 确认你的配置中 provider ID 是否为 "glm" (不是 "glm-provider" 或其他名称)');
console.log('2. 如果只有 glm 一个 provider,禁用后会因为没有可用的 provider 而失败');
console.log('3. 检查是否有其他 provider 可以作为 fallback');
console.log('4. 确认使用相同的 sessionId/conversationId,否则状态会隔离');