import {
  reportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy,
  resetProviderRuntimeIngressForTests,
  setProviderRuntimeObserverHooks,
  setProviderRuntimeProviderQuotaHooks,
  setProviderRuntimeQuotaHooks,
  setVirtualRouterPolicyRuntimeRouterHooks
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.js';

describe('provider runtime ingress', () => {
  let owner: object;
  let observedErrors: any[];
  let observedSuccesses: any[];
  let routerErrors: any[];
  let routerSuccesses: any[];
  let quotaErrors: any[];
  let quotaSuccesses: any[];
  let providerQuotaErrors: any[];

  beforeEach(() => {
    owner = {};
    observedErrors = [];
    observedSuccesses = [];
    routerErrors = [];
    routerSuccesses = [];
    quotaErrors = [];
    quotaSuccesses = [];
    providerQuotaErrors = [];
    resetProviderRuntimeIngressForTests();
    setVirtualRouterPolicyRuntimeRouterHooks(owner, {
      handleProviderError: (event) => routerErrors.push(event),
      handleProviderSuccess: (event) => routerSuccesses.push(event)
    });
    setProviderRuntimeQuotaHooks(owner, {
      onProviderError: (event) => quotaErrors.push(event),
      onProviderSuccess: (event) => quotaSuccesses.push(event)
    });
    setProviderRuntimeProviderQuotaHooks(owner, {
      onProviderError: (event) => providerQuotaErrors.push(event)
    });
    setProviderRuntimeObserverHooks(owner, {
      onProviderErrorReported: (event) => observedErrors.push(event),
      onProviderSuccessReported: (event) => observedSuccesses.push(event)
    });
  });

  afterEach(() => {
    setVirtualRouterPolicyRuntimeRouterHooks(owner, undefined);
    setProviderRuntimeQuotaHooks(owner, undefined);
    setProviderRuntimeProviderQuotaHooks(owner, undefined);
    setProviderRuntimeObserverHooks(owner, undefined);
    resetProviderRuntimeIngressForTests();
  });

  test('normalizes provider error events before fanout', () => {
    const before = Date.now();
    const returned = reportProviderErrorToRouterPolicy({
      code: 'HTTP_429',
      message: '',
      stage: '',
      affectsHealth: false,
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
    expect(returned.runtime).toEqual({});
    expect(returned.timestamp).toBeGreaterThanOrEqual(before);

    expect(routerErrors).toHaveLength(1);
    expect(quotaErrors).toHaveLength(1);
    expect(providerQuotaErrors).toHaveLength(1);
    expect(observedErrors).toHaveLength(1);
    expect(routerErrors[0]).toEqual(returned);
    expect(quotaErrors[0]).toEqual(returned);
    expect(providerQuotaErrors[0]).toEqual(returned);
    expect(observedErrors[0]).toEqual(returned);
  });

  test('normalizes provider success events before fanout', () => {
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

    expect(routerSuccesses).toHaveLength(1);
    expect(quotaSuccesses).toHaveLength(1);
    expect(observedSuccesses).toHaveLength(1);
    expect(routerSuccesses[0]).toEqual(returned);
    expect(quotaSuccesses[0]).toEqual(returned);
    expect(observedSuccesses[0]).toEqual(returned);
  });
});
