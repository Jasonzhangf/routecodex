import { describe, expect, it } from '@jest/globals';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-types.js';

describe('virtual-router-builder: routing policy group tagging', () => {
  it('requires an explicit routing policy group when multiple groups exist', async () => {
    const userConfig = {
      virtualrouterMode: 'v2',
      httpserver: { ports: [] },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5520: {
            routing: {
              thinking: [
                { id: 'gateway-priority-5520-thinking', targets: ['mini27.MiniMax-M2.7'] },
              ],
            },
          },
          gateway_coding_10000: {
            routing: {
              thinking: [
                { id: 'gateway-coding-10000-thinking', targets: ['llmgate.deepseek-v4-pro'] },
              ],
            },
          },
        },
      },
    };

    await expect(buildVirtualRouterInputV2(userConfig as any)).rejects.toThrow(
      'requires an explicit routingPolicyGroup'
    );
  });

  it('can explicitly merge all groups only for audit callers', async () => {
    const userConfig = {
      virtualrouterMode: 'v2',
      httpserver: { ports: [] },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5520: {
            routing: {
              thinking: [
                { id: 'gateway-priority-5520-thinking', targets: ['mini27.MiniMax-M2.7'] },
              ],
            },
          },
          gateway_coding_10000: {
            routing: {
              thinking: [
                { id: 'gateway-coding-10000-thinking', targets: ['llmgate.deepseek-v4-pro'] },
              ],
            },
          },
        },
      },
    };

    const result = await buildVirtualRouterInputV2(userConfig as any, undefined, {
      includeAllRoutingPolicyGroups: true,
    });
    expect(result.routing.thinking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gateway-priority-5520-thinking',
          routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_priority_5520' }),
        }),
        expect.objectContaining({
          id: 'gateway-coding-10000-thinking',
          routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_coding_10000' }),
        }),
      ]),
    );
  });

  it('builds a single routing policy group when requested', async () => {
    const userConfig = {
      virtualrouterMode: 'v2',
      httpserver: { ports: [] },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5555: {
            routing: {
              search: [
                {
                  id: 'gateway-priority-5555-search',
                  targets: ['mini27.MiniMax-M2.7'],
                  loadBalancing: { strategy: 'weighted' },
                },
              ],
            },
          },
          gateway_coding_10000: {
            routing: {
              search: [
                { id: 'gateway-coding-10000-search', targets: ['llmgate.deepseek-v4-pro'] },
              ],
            },
          },
        },
      },
    };

    const result = await buildVirtualRouterInputV2(userConfig as any, undefined, {
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(result.routing.search).toEqual([
      expect.objectContaining({
        id: 'gateway-priority-5555-search',
      routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_priority_5555' }),
      }),
    ]);
  });

  it('carries group-level hitLog omit config into the selected virtual router input', async () => {
    const userConfig = {
      virtualrouterMode: 'v2',
      httpserver: { ports: [] },
      virtualrouter: {
        routingPolicyGroups: {
          gateway_priority_5555: {
            hitLog: {
              omit: ['requestId', 'sessionId', 'reason', 'model']
            },
            routing: {
              longcontext: [
                {
                  id: 'gateway-priority-5555-longcontext',
                  targets: ['XLC.deepseek-v4-pro'],
                },
              ],
            },
          },
          gateway_priority_5520: {
            hitLog: {
              omit: ['stopMessage']
            },
            routing: {
              longcontext: [
                { id: 'gateway-priority-5520-longcontext', targets: ['mini27.MiniMax-M2.7'] },
              ],
            },
          },
        },
      },
    };

    const result = await buildVirtualRouterInputV2(userConfig as any, undefined, {
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(result.hitLog).toEqual({
      omit: ['requestId', 'sessionId', 'reason', 'model']
    });
  });
});
