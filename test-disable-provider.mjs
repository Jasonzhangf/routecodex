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
              sonnetkey: { value: 'SONNET' },
              sonnetbackup: { value: 'SONNET-BACKUP' },
              geminikey: { value: 'GEMINI' }
            }
          },
          models: {
            'claude-sonnet-4-5': {},
            'gemini-3-pro-high': {}
          }
        }
      },
      routing: {
        default: [
          'antigravity.claude-sonnet-4-5',
          'antigravity.geminikey.gemini-3-pro-high'
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

// 测试 #provider 指令
console.log('=== 测试 #provider 指令 ===\n');

const engine = buildEngine();
const sessionId = 'test-disable-provider-session';

// 1. 首先正常请求,应该能路由到 antigravity
console.log('1. 正常请求 (无指令):');
const normalRequest = buildRequest('测试消息');
const normalResult = engine.route(normalRequest, buildMetadata({ sessionId }));
console.log('  选中的 providerKey:', normalResult.target.providerKey);
console.log('  providerId:', normalResult.target.providerId);
console.log();

// 2. 使用 #antigravity 指令禁用整个 provider
console.log('2. 使用 <**#antigravity**> 禁用整个 provider:');
const disableProviderRequest = buildRequest('<**#antigravity**> 测试消息');
try {
  const disableResult = engine.route(disableProviderRequest, buildMetadata({ sessionId }));
  console.log('  ERROR: 应该抛出错误,但实际成功了!');
  console.log('  选中的 providerKey:', disableResult.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确抛出错误:', error.message);
}
console.log();

// 3. 后续请求应该仍然被禁用
console.log('3. 后续请求 (应该仍然被禁用):');
const followUpRequest = buildRequest('后续消息');
try {
  const followUpResult = engine.route(followUpRequest, buildMetadata({ sessionId }));
  console.log('  ERROR: 应该抛出错误,但实际成功了!');
  console.log('  选中的 providerKey:', followUpResult.target.providerKey);
} catch (error) {
  console.log('  ✓ 正确抛出错误:', error.message);
}
console.log();

// 4. 使用 clear 指令清除禁用
console.log('4. 使用 <**clear**> 清除禁用:');
const clearRequest = buildRequest('<**clear**> 恢复');
try {
  const clearResult = engine.route(clearRequest, buildMetadata({ sessionId }));
  console.log('  ✓ 成功恢复路由');
  console.log('  选中的 providerKey:', clearResult.target.providerKey);
} catch (error) {
  console.log('  ERROR: 清除后应该能正常路由,但失败了:', error.message);
}
console.log();

// 5. 测试 #provider.N 语法 (禁用第 N 个 key)
console.log('5. 使用 <**#antigravity.1**> 禁用第1个 key:');
const disableKeyRequest = buildRequest('<**#antigravity.1**> 测试');
const disableKeyResult = engine.route(disableKeyRequest, buildMetadata({ sessionId: 'test-disable-key' }));
console.log('  选中的 providerKey:', disableKeyResult.target.providerKey);
console.log('  (应该不是 antigravity.claude-sonnet-4-5)');
console.log();

// 6. 测试 #provider.alias 语法 (禁用指定 alias)
console.log('6. 使用 <**#antigravity.geminikey**> 禁用指定 alias:');
const disableAliasRequest = buildRequest('<**#antigravity.geminikey**> 测试');
const disableAliasResult = engine.route(disableAliasRequest, buildMetadata({ sessionId: 'test-disable-alias' }));
console.log('  选中的 providerKey:', disableAliasResult.target.providerKey);
console.log('  (应该不是 antigravity.geminikey)');
console.log();

// 7. 测试 #provider.model 语法 (禁用指定模型)
console.log('7. 使用 <**#antigravity.claude-sonnet-4-5**> 禁用指定模型:');
const disableModelRequest = buildRequest('<**#antigravity.claude-sonnet-4-5**> 测试');
const disableModelResult = engine.route(disableModelRequest, buildMetadata({ sessionId: 'test-disable-model' }));
console.log('  选中的 providerKey:', disableModelResult.target.providerKey);
console.log('  (应该不是 claude-sonnet-4-5 模型)');
console.log();

console.log('=== 测试完成 ===');