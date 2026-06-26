import {
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy,
  resetProviderRuntimeIngressForTests,
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.js';

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
