import { bootstrapVirtualRouterConfig } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../sharedmodule/llmswitch-core/dist/router/virtual-router/engine.js';

// 模拟你的实际配置: glm 同时在 default 和 web_search 路由中
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
        },
        kimi: {
          id: 'kimi',
          type: 'openai',
          endpoint: 'https://api.kimi.com/v1',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'KIMI_KEY' }
            }
          },
          models: {
            'kimi-k2': {}
          }
        },
        gemini: {
          id: 'gemini',
          type: 'openai',
          endpoint: 'https://api.gemini.com/v1',
          auth: {
            type: 'apikey',
            keys: {
              key1: { value: 'GEMINI_KEY' }
            }
          },
          models: {
            'gemini-2.5-flash-lite': {}
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default-primary',
            priority: 200,
            targets: ['crs.gpt-5.2-codex', 'tab.gpt-5.2-codex']
          },
          {
            id: 'default-backup',
            backup: true,
            targets: ['glm.glm-4.7']
          }
        ],
        web_search: [
          {
            id: 'web_search-primary',
            targets: ['kimi.kimi-k2', 'gemini.gemini-2.5-flash-lite', 'glm.glm-4.7']
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

function buildRequest(userContent, webSearchEnabled = false) {
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
      webSearchEnabled
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

console.log('=== 测试 glm 在多个路由中的场景 ===\n');

const engine = buildEngine();

// 场景 1: default 路由,禁用 glm,应该路由到 crs 或 tab
console.log('场景 1: default 路由 + 禁用 glm');
const result1 = engine.route(
  buildRequest('<**#glm**> 测试'),
  buildMetadata({ sessionId: 'test-scenario-1', routeHint: 'default' })
);
console.log('  选中:', result1.target.providerKey);
console.log('  路由:', result1.decision.routeName);
if (result1.target.providerKey.includes('glm')) {
  console.log('  ✗ 错误: 不应该选中 glm!');
} else {
  console.log('  ✓ 正确: 没有选中 glm');
}
console.log();

// 场景 2: web_search 路由,禁用 glm,应该路由到 kimi 或 gemini
console.log('场景 2: web_search 路由 + 禁用 glm');
const result2 = engine.route(
  buildRequest('<**#glm**> 搜索', true),
  buildMetadata({
    sessionId: 'test-scenario-2',
    routeHint: 'web_search',
    webSearchEnabled: true
  })
);
console.log('  选中:', result2.target.providerKey);
console.log('  路由:', result2.decision.routeName);
if (result2.target.providerKey.includes('glm')) {
  console.log('  ✗ 错误: 不应该选中 glm!');
} else {
  console.log('  ✓ 正确: 没有选中 glm');
}
console.log();

// 场景 3: default 路由,不禁用 glm,但 crs 和 tab 不可用时,应该落到 glm
console.log('场景 3: default 路由 + 禁用 crs 和 tab');
const result3 = engine.route(
  buildRequest('<**#crs,tab**> 测试'),
  buildMetadata({ sessionId: 'test-scenario-3', routeHint: 'default' })
);
console.log('  选中:', result3.target.providerKey);
console.log('  路由:', result3.decision.routeName);
if (result3.target.providerKey.includes('glm')) {
  console.log('  ✓ 正确: 落到 backup 池的 glm');
} else {
  console.log('  ✗ 错误: 应该落到 backup 池的 glm');
}
console.log();

// 场景 4: web_search 路由,不禁用,应该可能选中 glm
console.log('场景 4: web_search 路由 + 不禁用');
const result4 = engine.route(
  buildRequest('搜索', true),
  buildMetadata({
    sessionId: 'test-scenario-4',
    routeHint: 'web_search',
    webSearchEnabled: true
  })
);
console.log('  选中:', result4.target.providerKey);
console.log('  路由:', result4.decision.routeName);
console.log('  (可能选中 glm, kimi 或 gemini)');
console.log();

// 场景 5: 同一个 session,先在 default 路由禁用 glm,然后在 web_search 路由
console.log('场景 5: 同一 session,先 default 禁用 glm,再 web_search');
const sessionId5 = 'test-scenario-5';

// 先在 default 路由禁用 glm
const result5a = engine.route(
  buildRequest('<**#glm**> 测试'),
  buildMetadata({ sessionId: sessionId5, routeHint: 'default' })
);
console.log('  步骤 1 (default 路由):', result5a.target.providerKey);

// 再在 web_search 路由请求
const result5b = engine.route(
  buildRequest('搜索', true),
  buildMetadata({
    sessionId: sessionId5,
    routeHint: 'web_search',
    webSearchEnabled: true
  })
);
console.log('  步骤 2 (web_search 路由):', result5b.target.providerKey);
if (result5b.target.providerKey.includes('glm')) {
  console.log('  ✗ 错误: web_search 路由中不应该选中 glm (因为 glm 已被禁用)!');
} else {
  console.log('  ✓ 正确: web_search 路由中也没有选中 glm');
}
console.log();

console.log('=== 测试完成 ===');
console.log('\n💡 关键发现:');
console.log('1. glm.glm-4.7 同时在 default 和 web_search 两个路由中');
console.log('2. <**#glm**> 会禁用 glm provider,影响所有路由');
console.log('3. 如果你看到还是命中 glm,可能原因:');
console.log('   - 请求被路由到了 web_search 路由,但你只在 default 路由中禁用了 glm');
console.log('   - 使用了不同的 sessionId/conversationId,导致状态隔离');
console.log('   - 有其他指令覆盖了禁用状态');
console.log('\n🎯 建议检查:');
console.log('- 查看日志中的 routeHint,确认请求实际命中了哪个路由');
console.log('- 确认使用相同的 sessionId/conversationId');
console.log('- 检查是否有其他路由指令(如 !provider)影响了路由选择')