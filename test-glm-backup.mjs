import { bootstrapVirtualRouterConfig } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/engine.js';

// 模拟你的实际配置
function buildEngine() {
  const input = {
    virtualrouter: {
      providers: {
        crs: {
          id: 'crs',
          type: 'openai',
          endpoint: 'https://api.crs.com/v1',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'CRS_KEY' }
            }
          },
          models: {
            'gpt-5.2-codex': {}
          }
        },
        tab: {
          id: 'tab',
          type: 'openai',
          endpoint: 'https://api.tab.com/v1',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'TAB_KEY' }
            }
          },
          models: {
            'gpt-5.2-codex': {}
          }
        },
        glm: {
          id: 'glm',
          type: 'openai',
          endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'GLM_KEY' }
            }
          },
          models: {
            'glm-4.7': {}
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default-primary',
            priority: 200,
            targets: [
              'crs.gpt-5.2-codex',
              'tab.gpt-5.2-codex'
            ]
          },
          {
            id: 'default-backup',
            backup: true,
            targets: [
              'glm.glm-4.7'
            ]
          }
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

console.log('=== 测试 glm 在 backup 池中的场景 ===\n');

const engine = buildEngine();

// 场景 1: 正常请求,应该路由到 primary 池
console.log('场景 1: 正常请求(无禁用)');
const result1 = engine.route(
  buildRequest('测试'),
  buildMetadata({ sessionId: 'test-scenario-1' })
);
console.log('  选中:', result1.target.providerKey);
console.log('  (应该来自 primary 池: crs 或 tab)');
console.log();

// 场景 2: 禁用 glm,但 glm 在 backup 池中,不应该影响 primary 池
console.log('场景 2: 禁用 glm (glm 在 backup 池中)');
const result2 = engine.route(
  buildRequest('<**#glm**> 测试'),
  buildMetadata({ sessionId: 'test-scenario-2' })
);
console.log('  选中:', result2.target.providerKey);
console.log('  (应该仍然来自 primary 池,因为 glm 在 backup 池)');
if (result2.target.providerKey.includes('glm')) {
  console.log('  ✗ 错误: 不应该选中 glm!');
} else {
  console.log('  ✓ 正确: 没有选中 glm');
}
console.log();

// 场景 3: 禁用 primary 池的所有 provider,才会落到 backup 池
console.log('场景 3: 禁用 crs 和 tab,应该落到 backup 池');
const result3 = engine.route(
  buildRequest('<**#crs,tab**> 测试'),
  buildMetadata({ sessionId: 'test-scenario-3' })
);
console.log('  选中:', result3.target.providerKey);
if (result3.target.providerKey.includes('glm')) {
  console.log('  ✓ 正确: 落到 backup 池的 glm');
} else {
  console.log('  ✗ 错误: 应该落到 backup 池的 glm');
}
console.log();

// 场景 4: 禁用所有 provider (包括 glm)
console.log('场景 4: 禁用所有 provider (crs, tab, glm)');
try {
  const result4 = engine.route(
    buildRequest('<**#crs,tab,glm**> 测试'),
    buildMetadata({ sessionId: 'test-scenario-4' })
  );
  console.log('  ✗ 错误: 应该抛出错误,但成功了:', result4.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确抛出错误:', error.message);
}
console.log();

console.log('=== 测试完成 ===');
console.log('\n💡 问题分析:');
console.log('1. 你的配置中 glm.glm-4.7 在 default-backup 池中');
console.log('2. <**#glm**> 会禁用 glm provider,但因为有 crs 和 tab 在 primary 池中');
console.log('3. 请求会继续路由到 primary 池的 crs 或 tab,看起来像是"禁用失败"');
console.log('4. 实际上禁用是生效的,只是因为有其他可用的 provider');
console.log('\n🎯 验证方法:');
console.log('- 禁用所有 provider: <**#crs,tab,glm**>');
console.log('- 或者只使用 glm: <**!glm**> (sticky 指令)');
console.log('- 或者禁用 primary 池: <**#crs,tab**>');