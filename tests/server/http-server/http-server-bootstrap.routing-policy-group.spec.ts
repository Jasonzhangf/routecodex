import { describe, expect, test } from '@jest/globals';
import { extractProviderKeysForRoutingGroup } from '../../../src/server/runtime/http-server/http-server-bootstrap.js';

describe('http-server bootstrap routingPolicyGroup allowlist extraction', () => {
  test('normalizes provider.model targets into provider-id allowlist', () => {
    const userConfig = {
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5520: {
            routing: {
              coding: [
                {
                  targets: ['llmgate.deepseek-v4-pro', 'mini27.MiniMax-M2.7'],
                  loadBalancing: {
                    weights: {
                      'llmgate.deepseek-v4-pro': 1,
                      'mini27.MiniMax-M2.7': 1,
                    },
                  },
                },
              ],
              tools: [
                {
                  targets: ['mini27.MiniMax-M2.7', 'mimo.mimo-v2.5-pro'],
                },
              ],
              default: [
                {
                  target: 'qwenchat.qwen3.6-plus',
                },
              ],
            },
          },
        },
      },
    };

    expect(extractProviderKeysForRoutingGroup(userConfig as any, 'gateway_priority_5520').sort()).toEqual([
      'llmgate',
      'mimo',
      'mini27',
      'qwenchat',
    ]);
  });

  test('normalizes explicit provider keys and provider ids without leaking alias/model segments', () => {
    const userConfig = {
      virtualrouter: {
        routingPolicyGroups: {
          provider_port: {
            routing: {
              default: [
                {
                  provider: 'dbittai-gpt.key1.gpt-5.4',
                },
                {
                  provider: 'llmgate',
                },
              ],
            },
          },
        },
      },
    };

    expect(extractProviderKeysForRoutingGroup(userConfig as any, 'provider_port').sort()).toEqual([
      'dbittai-gpt',
      'llmgate',
    ]);
  });

  test('returns empty array for missing routingPolicyGroup', () => {
    expect(extractProviderKeysForRoutingGroup({ virtualrouter: { routingPolicyGroups: {} } } as any, 'missing')).toEqual([]);
  });
});
