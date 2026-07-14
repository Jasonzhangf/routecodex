import { describe, expect, it } from '@jest/globals';
import { compileRouteCodexRuntimeConfigManifest } from '../../src/config/user-config-loader.js';

async function compileVirtualRouterInput(userConfig: Record<string, unknown>, providerRootDir?: string, options?: Parameters<typeof compileRouteCodexRuntimeConfigManifest>[2]) {
  return (await compileRouteCodexRuntimeConfigManifest(userConfig, providerRootDir, options)).virtualRouterBootstrapInput;
}

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

    await expect(compileVirtualRouterInput(userConfig as any)).rejects.toThrow(
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

    const result = await compileVirtualRouterInput(userConfig as any, undefined, {
      includeAllRoutingPolicyGroups: true,
    });
    expect(result.routing.thinking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_priority_5520' }),
        }),
        expect.objectContaining({
          routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_coding_10000' }),
        }),
      ]),
    );
    for (const pool of result.routing.thinking) {
      expect(pool).not.toHaveProperty('id');
      expect(pool).not.toHaveProperty('poolId');
    }
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

    const result = await compileVirtualRouterInput(userConfig as any, undefined, {
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(result.routing.search).toEqual([
      expect.objectContaining({
        routeParams: expect.objectContaining({ routePolicyGroup: 'gateway_priority_5555' }),
      }),
    ]);
    expect(result.routing.search[0]).not.toHaveProperty('id');
    expect(result.routing.search[0]).not.toHaveProperty('poolId');
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

    const result = await compileVirtualRouterInput(userConfig as any, undefined, {
      routingPolicyGroup: 'gateway_priority_5555',
    });

    expect(result.hitLog).toEqual({
      omit: ['requestId', 'sessionId', 'reason', 'model']
    });
  });
});
