import { HubPipeline } from '../../src/conversion/hub/pipeline/hub-pipeline.js';
import type { VirtualRouterConfig } from '../../src/router/virtual-router/types.js';

const routerConfig: VirtualRouterConfig = {
  routing: {
    default: [
      {
        id: 'primary',
        priority: 100,
        targets: ['openai-primary']
      }
    ],
    web_search: [
      {
        id: 'web-search-backends',
        priority: 200,
        targets: ['glm-search.backend']
      }
    ]
  },
  providers: {
    'openai-primary': {
      providerKey: 'openai-primary',
      providerType: 'openai',
      endpoint: 'https://api.fake-openai.local/v1',
      auth: {
        type: 'apiKey',
        value: 'test-key'
      },
      outboundProfile: 'openai-chat',
      compatibilityProfile: 'compat:passthrough',
      modelId: 'gpt-4o-mini',
      processMode: 'chat'
    },
    'glm-search.backend': {
      providerKey: 'glm-search.backend',
      providerType: 'glm',
      endpoint: 'https://api.fake-glm-search.local/v1',
      auth: {
        type: 'apiKey',
        value: 'search-key'
      },
      outboundProfile: 'openai-chat',
      compatibilityProfile: 'compat:passthrough',
      modelId: 'glm-4.7',
      processMode: 'chat'
    }
  },
  classifier: {
    longContextThresholdTokens: 60000,
    thinkingKeywords: [],
    codingKeywords: [],
    backgroundKeywords: [],
    visionKeywords: []
  },
  loadBalancing: {
    strategy: 'round-robin'
  },
  health: {
    failureThreshold: 3,
    cooldownMs: 30_000,
    fatalCooldownMs: 300_000
  },
  webSearch: {
    engines: [
      {
        id: 'glm',
        providerKey: 'glm-search.backend',
        description: 'GLM 4.7 web search backend',
        default: true
      }
    ],
    injectPolicy: 'always'
  }
};


const directRouteRouterConfig: VirtualRouterConfig = {
  ...routerConfig,
  webSearch: {
    engines: [
      {
        id: 'deepseek:web_search',
        providerKey: 'glm-search.backend',
        modelId: 'deepseek-chat',
        executionMode: 'direct',
        directActivation: 'route',
        default: true
      }
    ],
    injectPolicy: 'always'
  }
};

const anthropicThinkingRouterConfig: VirtualRouterConfig = {
  routing: {
    default: [
      {
        id: 'primary',
        priority: 100,
        targets: ['ali-coding-plan.key1.glm-5']
      }
    ]
  },
  providers: {
    'ali-coding-plan.key1.glm-5': {
      providerKey: 'ali-coding-plan.key1.glm-5',
      providerType: 'anthropic',
      endpoint: 'https://example.test/anthropic',
      auth: {
        type: 'apiKey',
        value: 'test-key'
      },
      outboundProfile: 'anthropic-messages',
      compatibilityProfile: 'anthropic:claude-code',
      modelId: 'glm-5',
      processMode: 'chat',
      anthropicThinking: 'medium'
    }
  },
  classifier: {
    longContextThresholdTokens: 60000,
    thinkingKeywords: [],
    codingKeywords: [],
    backgroundKeywords: [],
    visionKeywords: []
  },
  loadBalancing: {
    strategy: 'round-robin'
  },
  health: {
    failureThreshold: 3,
    cooldownMs: 30_000,
    fatalCooldownMs: 300_000
  }
};

describe('HubPipeline orchestration', () => {
  const pipeline = new HubPipeline({ virtualRouter: routerConfig });

  test('runs inbound -> process -> router -> outbound using hub components', async () => {
    const result = await pipeline.execute({
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say hello and mention today is sunny.' }
        ],
        stream: false
      }
    });

    expect(result.requestId).toBeTruthy();
    expect(result.standardizedRequest?.messages.length).toBe(2);
    expect(result.processedRequest?.messages.length).toBeGreaterThan(0);
    expect(result.providerPayload).toBeDefined();
    expect(result.routingDecision?.providerKey).toBe('openai-primary');
    expect(result.target?.providerType).toBe('openai');
    expect(result.nodeResults.length).toBeGreaterThanOrEqual(3);
  });

  test('injects unified web_search tool when servertool webSearch config is present', async () => {
    const result = await pipeline.execute({
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: '帮我联网搜索一下今天的新闻。' }
        ],
        stream: false
      }
    });

    const standardized = result.standardizedRequest;
    const processed = result.processedRequest;

    expect(standardized).toBeDefined();
    expect(processed).toBeDefined();

    const tools = processed?.tools ?? standardized?.tools ?? [];
    const webSearchTools = (tools || []).filter(
      (tool) => tool?.type === 'function' && tool.function?.name === 'web_search'
    );
    expect(webSearchTools.length).toBe(1);
  });

  test('skips canonical web_search injection when only direct route engines are configured', async () => {
    const directPipeline = new HubPipeline({ virtualRouter: directRouteRouterConfig });
    const result = await directPipeline.execute({
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: '帮我联网搜索一下今天的新闻。' }
        ],
        stream: false
      }
    });

    const tools = result.processedRequest?.tools ?? result.standardizedRequest?.tools ?? [];
    const webSearchTools = (tools || []).filter(
      (tool) => tool?.type === 'function' && tool.function?.name === 'web_search'
    );
    expect(webSearchTools.length).toBe(0);
  });

  test('propagates target anthropicThinking into outbound anthropic payload', async () => {
    const anthropicPipeline = new HubPipeline({ virtualRouter: anthropicThinkingRouterConfig });
    const result = await anthropicPipeline.execute({
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'glm-5',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      }
    });

    expect(result.routingDecision?.providerKey).toBe('ali-coding-plan.key1.glm-5');
    expect((result.providerPayload as Record<string, unknown>).thinking).toEqual({
      type: 'adaptive'
    });
    expect((result.providerPayload as Record<string, unknown>).output_config).toEqual({
      effort: 'high'
    });
  });
});
