import { getRouterHotpathJsonBindingSync } from '../../src/modules/llmswitch/bridge/native-exports.js';

function callProviderRuntimeIngress<TEvent>(name: string, event?: TEvent): TEvent {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding[name];
  if (typeof fn !== 'function') {
    throw new Error(`missing native provider runtime ingress export: ${name}`);
  }
  const raw = event === undefined ? (fn as () => unknown)() : (fn as (inputJson: string) => unknown)(JSON.stringify(event));
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`empty native provider runtime ingress result: ${name}`);
  }
  return JSON.parse(raw) as TEvent;
}

function reportProviderErrorToRouterPolicy<TEvent>(event: TEvent): TEvent {
  return callProviderRuntimeIngress('reportProviderErrorToRouterPolicyJson', event);
}

function reportProviderSuccessToRouterPolicy<TEvent>(event: TEvent): TEvent {
  return callProviderRuntimeIngress('reportProviderSuccessToRouterPolicyJson', event);
}

function resetProviderRuntimeIngressForTests(): void {
  callProviderRuntimeIngress('resetProviderRuntimeIngressForTestsJson');
}

describe('provider runtime ingress', () => {
  beforeEach(() => {
    resetProviderRuntimeIngressForTests();
  });

  afterEach(() => {
    resetProviderRuntimeIngressForTests();
  });

  test('normalizes provider error events through native router policy ingress', () => {
    const before = Date.now();
    const returned = reportProviderErrorToRouterPolicy({
      code: 'HTTP_429',
      message: '',
      stage: '',
      affectsHealth: false,
      fatal: true,
      errorClassification: 'unrecoverable',
      runtime: undefined as any,
      timestamp: undefined as any,
      details: {
        source: 'unit'
      }
    } as any);

    expect(returned.code).toBe('HTTP_429');
    expect(returned.message).toBe('HTTP_429');
    expect(returned.stage).toBe('unknown');
    expect(returned.affectsHealth).toBe(false);
    expect(returned.fatal).toBe(true);
    expect(returned.cooldownOverrideMs).toBeUndefined();
    expect(returned.errorClassification).toBe('unrecoverable');
    expect(returned.runtime).toEqual({});
    expect(returned.timestamp).toBeGreaterThanOrEqual(before);
  });

  test('normalizes provider success events through native router policy ingress', () => {
    const before = Date.now();
    const returned = reportProviderSuccessToRouterPolicy({
      runtime: undefined as any,
      timestamp: undefined as any,
      metadata: {
        source: 'unit'
      }
    } as any);

    expect(returned.runtime).toEqual({});
    expect(returned.timestamp).toBeGreaterThanOrEqual(before);
    expect(returned.metadata).toEqual({ source: 'unit' });
  });
});
