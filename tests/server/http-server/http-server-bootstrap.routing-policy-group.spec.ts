import { describe, expect, test } from '@jest/globals';
import {
  extractProviderKeysForRoutingGroup,
  extractRoutingTiersForRoutingGroupRoute,
} from '../../../src/server/runtime/http-server/http-server-bootstrap.js';

describe('http-server bootstrap routingPolicyGroup allowlist extraction', () => {
  test('normalizes provider.model targets into provider-id allowlist', () => {
    const userConfig = {
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5520: {
            routing: {
              coding: [
                {
                  targets: ['llmgate.demo-v4-pro', 'mini27.MiniMax-M2.7'],
                  loadBalancing: {
                    weights: {
                      'llmgate.demo-v4-pro': 1,
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
                  target: 'demochat.demo3.6-plus',
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
      'demochat',
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

  test('expands forwarder targets into real provider ids for router port allowlist', () => {
    const userConfig = {
      virtualrouter: {
        forwarders: {
          'fwd.gpt.gpt-5.5': {
            targets: [
              { providerId: 'sdfv', providerKey: 'sdfv.key1.gpt-5.5' },
              { providerId: 'llmgate', providerKey: 'llmgate.key1.free-gpt-5.5' },
              { providerId: 'asxs', providerKey: 'asxs.crsa.gpt-5.5' },
              { providerId: 'cc', providerKey: 'cc.key1.gpt-5.5' },
            ],
          },
          'fwd.minimax.MiniMax-M3': {
            targets: [
              { providerId: 'minimax', providerKey: 'minimax.key1.MiniMax-M3' },
            ],
          },
        },
        routingPolicyGroups: {
          gateway_priority_5555: {
            routing: {
              thinking: [
                {
                  mode: 'priority',
                  targets: ['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3', 'mimo.mimo-v2.5'],
                },
              ],
            },
          },
        },
      },
    };

    expect(extractProviderKeysForRoutingGroup(userConfig as any, 'gateway_priority_5555').sort()).toEqual([
      'asxs',
      'cc',
      'llmgate',
      'mimo',
      'minimax',
      'sdfv',
    ]);
  });

  test('returns empty array for missing routingPolicyGroup', () => {
    expect(extractProviderKeysForRoutingGroup({ virtualrouter: { routingPolicyGroups: {} } } as any, 'missing')).toEqual([]);
  });

  test('extracts exact route tiers for primary_exhausted planner without flattening forwarders', () => {
    const userConfig = {
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5555: {
            routing: {
              coding: [
                {
                  id: 'coding-primary',
                  priority: 200,
                  mode: 'priority',
                  targets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
                },
                {
                  id: 'coding-backup',
                  priority: 100,
                  backup: true,
                  targets: ['fwd.minimax.MiniMax-M3'],
                },
              ],
              default: [
                {
                  id: 'default-primary',
                  priority: 50,
                  targets: ['mimo.mimo-v2.5'],
                },
              ],
            },
          },
        },
      },
    };

    expect(extractRoutingTiersForRoutingGroupRoute(userConfig as any, 'gateway_priority_5555', 'coding')).toEqual([
      {
        id: 'coding-primary',
        priority: 200,
        backup: undefined,
        targets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
      },
      {
        id: 'coding-backup',
        priority: 100,
        backup: true,
        targets: ['fwd.minimax.MiniMax-M3'],
      },
    ]);
  });
});
