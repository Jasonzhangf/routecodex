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

function buildRequest(userContent, metadataOverrides = {}) {
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
      webSearchEnabled: false,
      ...metadataOverrides
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

console.log('=== 调试:检查为什么禁用后还会命中 glm ===\n');

const engine = buildEngine();

// 测试 1: 检查路由状态
console.log('测试 1: 检查当前路由状态');
const status = engine.getStatus();
console.log('  default 路由的池:', Object.keys(status.routes.default?.pools || {}));
console.log('  web_search 路由的池:', Object.keys(status.routes.web_search?.pools || {}));
console.log();

// 测试 2: 模拟你的场景 - 禁用 glm 后请求
console.log('测试 2: 禁用 glm 后发送请求');
const sessionId = 'debug-session-1';

// 第一次请求: 禁用 glm
console.log('  步骤 1: 发送 <**#glm**>');
try {
  const result1 = engine.route(
    buildRequest('<**#glm**> 测试'),
    buildMetadata({ sessionId, routeHint: 'default' })
  );
  console.log('    结果:', result1.target.providerKey, '(路由:', result1.decision.routeName + ')');
} catch (error) {
  console.log('    错误:', error.message);
}

// 第二次请求: 不带指令,应该仍然被禁用
console.log('  步骤 2: 发送普通请求 (同一 session)');
try {
  const result2 = engine.route(
    buildRequest('继续'),
    buildMetadata({ sessionId, routeHint: 'default' })
  );
  console.log('    结果:', result2.target.providerKey, '(路由:', result2.decision.routeName + ')');
  if (result2.target.providerKey.includes('glm')) {
    console.log('    ⚠️  警告: 选中了 glm,但应该被禁用!');
  }
} catch (error) {
  console.log('    错误:', error.message);
}
console.log();

// 测试 3: 检查 web_search 路由
console.log('测试 3: web_search 路由 + 禁用 glm');
const sessionId3 = 'debug-session-3';

// 禁用 glm
console.log('  步骤 1: 发送 <**#glm**>');
try {
  const result3a = engine.route(
    buildRequest('<**#glm**> 测试'),
    buildMetadata({ sessionId: sessionId3, routeHint: 'default' })
  );
  console.log('    结果:', result3a.target.providerKey);
} catch (error) {
  console.log('    错误:', error.message);
}

// 触发 web_search 路由
console.log('  步骤 2: 触发 web_search 路由');
try {
  const result3b = engine.route(
    buildRequest('搜索'),
    buildMetadata({
      sessionId: sessionId3,
      routeHint: 'web_search',
      webSearchEnabled: true
    })
  );
  console.log('    结果:', result3b.target.providerKey, '(路由:', result3b.decision.routeName + ')');
  if (result3b.target.providerKey.includes('glm')) {
    console.log('    ⚠️  警告: 选中了 glm,但应该被禁用!');
  }
} catch (error) {
  console.log('    错误:', error.message);
}
console.log();

// 测试 4: 检查是否有 sticky 指令干扰
console.log('测试 4: 检查 sticky 指令是否干扰');
const sessionId4 = 'debug-session-4';

// 先设置 sticky 到 glm
console.log('  步骤 1: 设置 sticky 到 glm <**!glm**>');
try {
  const result4a = engine.route(
    buildRequest('<**!glm**> 测试'),
    buildMetadata({ sessionId: sessionId4, routeHint: 'default' })
  );
  console.log('    结果:', result4a.target.providerKey);
} catch (error) {
  console.log('    错误:', error.message);
}

// 再禁用 glm
console.log('  步骤 2: 禁用 glm <**#glm**>');
try {
  const result4b = engine.route(
    buildRequest('<**#glm**> 测试'),
    buildMetadata({ sessionId: sessionId4, routeHint: 'default' })
  );
  console.log('    结果:', result4b.target.providerKey);
  if (result4b.target.providerKey.includes('glm')) {
    console.log('    ⚠️  警告: 选中了 glm,可能是因为 sticky 指令优先级更高!');
  }
} catch (error) {
  console.log('    错误:', error.message);
}
console.log();

console.log('=== 调试完成 ===');
console.log('\n🔍 请提供以下信息帮助定位问题:');
console.log('1. 你看到的命中 glm 的具体日志输出');
console.log('2. 你使用的是哪个客户端 (CLI/HTTP API/其他)?');
console.log('3. 你的请求内容是什么?是否包含搜索相关内容?');
console.log('4. 你是否在同一 session 中使用了其他路由指令 (如 !provider)?');
console.log('5. 日志中显示的 routeHint 是什么?');