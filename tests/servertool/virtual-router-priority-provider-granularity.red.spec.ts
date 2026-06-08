import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';

describe('virtual-router priority provider granularity', () => {
  test('priority route should keep provider-level target and avoid key-level expansion', () => {
    const input: any = {
      providers: {
        mimo: {
          id: 'mimo',
          type: 'anthropic',
          baseURL: 'https://example.test/anthropic',
          defaultModel: 'mimo-v2.5',
          auth: {
            type: 'apikey',
            entries: [
              { alias: 'key1', apiKey: 'k1' },
              { alias: 'key2', apiKey: 'k2' }
            ]
          },
          models: {
            'mimo-v2.5': { supportsStreaming: true }
          }
        }
      },
      routing: {
        tools: [
          {
            id: 'tools-priority',
            mode: 'priority',
            targets: ['mimo.mimo-v2.5']
          }
        ]
      }
    };

    const boot = bootstrapVirtualRouterConfig(input);
    const toolsPools = boot.routing.tools ?? [];
    expect(toolsPools.length).toBe(1);
    const targets = toolsPools[0]?.targets ?? [];

    // 语义要求：priority 颗粒度在 provider，key 轮询在 provider 内；路由层不展开 key1/key2。
    expect(targets).toEqual(['mimo.pool.mimo-v2.5']);
    expect(targets.some((target) => target.includes('.key1.'))).toBe(false);
    expect(targets.some((target) => target.includes('.key2.'))).toBe(false);
  });
});
