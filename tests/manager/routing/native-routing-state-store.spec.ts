import { describe, expect, it, jest } from '@jest/globals';

let nativeBinding: Record<string, unknown> = {};

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  getRouterHotpathJsonBindingSync: () => nativeBinding,
}));

const {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync,
} = await import('../../../src/manager/modules/routing/native-routing-state-store.js');

describe('manager native routing state store bridge', () => {
  it('serializes host Set/Map containers through the Rust routing-state codec', () => {
    const saved: Array<{ key: string; stateJson: string; sessionDir?: string }> = [];
    nativeBinding = {
      serializeRoutingInstructionStateJson: jest.fn((inputJson: string) => inputJson),
      saveRoutingInstructionStateJson: jest.fn((key: string, stateJson: string, sessionDir?: string) => {
        saved.push({ key, stateJson, sessionDir });
      }),
    };

    saveRoutingInstructionStateSync('session:test', {
      allowedProviders: new Set(['p1']),
      disabledProviders: new Set(['p2']),
      disabledKeys: new Map([['p3', new Set(['k1'])]]),
      disabledModels: new Map([['p4', new Set(['m1'])]]),
      stopMessageText: 'continue',
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.key).toBe('session:test');
    expect(saved[0]?.sessionDir).toBe('__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__');
    expect(JSON.parse(saved[0]?.stateJson ?? '{}')).toMatchObject({
      allowedProviders: ['p1'],
      disabledProviders: ['p2'],
      disabledKeys: [{ provider: 'p3', keys: ['k1'] }],
      disabledModels: [{ provider: 'p4', models: ['m1'] }],
      stopMessageText: 'continue',
    });
  });

  it('hydrates Rust-decoded arrays back into host Set/Map containers', () => {
    nativeBinding = {
      loadRoutingInstructionStateJson: jest.fn(() => JSON.stringify({
        allowedProviders: ['p1'],
        disabledProviders: ['p2'],
        disabledKeys: [{ provider: 'p3', keys: ['k1'] }],
        disabledModels: [{ provider: 'p4', models: ['m1'] }],
      })),
      deserializeRoutingInstructionStateJson: jest.fn((inputJson: string) => inputJson),
    };

    const loaded = loadRoutingInstructionStateSync('session:test') as Record<string, unknown>;

    expect(loaded.allowedProviders).toBeInstanceOf(Set);
    expect([...(loaded.allowedProviders as Set<string>)]).toEqual(['p1']);
    expect(loaded.disabledKeys).toBeInstanceOf(Map);
    expect([...(loaded.disabledKeys as Map<string, Set<string>>).get('p3') ?? []]).toEqual(['k1']);
    expect(loaded.disabledModels).toBeInstanceOf(Map);
    expect([...(loaded.disabledModels as Map<string, Set<string>>).get('p4') ?? []]).toEqual(['m1']);
  });

  it('fails explicitly when the native routing-state store capability is missing', () => {
    nativeBinding = {};

    expect(() => loadRoutingInstructionStateSync('session:missing')).toThrow(/ROUTING_STATE_STORE_FAILED|loadRoutingInstructionStateJson native unavailable/);
  });
});
