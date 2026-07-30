import { describe, expect, it, jest } from '@jest/globals';
import {
  executeProviderDirectPipeline,
  resolveInboundProtocolFromEntryPath
} from '../../../../src/server/runtime/http-server/provider-direct-pipeline.js';
import type { ProviderRetryExecutionPlan } from '../../../../src/server/runtime/http-server/executor/request-executor-error-types.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';

function plan(
  action: ProviderRetryExecutionPlan['action']
): ProviderRetryExecutionPlan {
  const waiting = action === 'wait_then_retry_same' || action === 'wait_then_reselect';
  return {
    action,
    shouldRetry: waiting,
    excludedCurrentProvider: action === 'wait_then_reselect',
    allowRetryBeyondAttemptBudget: action === 'wait_then_retry_same',
    ...(action === 'wait_then_reselect'
      ? {
          retrySwitchPlan: {
            switchAction: 'exclude_and_reroute' as const,
            decisionLabel: 'exclude_and_reroute',
            runtimeScopeExcluded: ['provider-a'],
            runtimeScopeExcludedCount: 1
          }
        }
      : {}),
    routePoolRemainingAfterExclusion:
      action === 'wait_then_reselect' ? ['provider-b'] : [],
    defaultPoolAvailable: waiting,
    policyExhausted: action === 'project_terminal',
    mayProject: action === 'project_terminal'
  };
}

function handleWith(
  processIncomingDirect: ProviderHandle['instance']['processIncomingDirect']
): ProviderHandle {
  return {
    runtimeKey: 'provider-a',
    providerId: 'provider-a',
    providerType: 'mock',
    providerFamily: 'mock',
    providerProtocol: 'openai-responses',
    runtime: {} as never,
    instance: {
      initialize: async () => undefined,
      cleanup: async () => undefined,
      processIncoming: async () => {
        throw new Error('unexpected non-direct send');
      },
      processIncomingDirect
    }
  };
}

const portConfig = {
  port: 5007,
  host: '127.0.0.1',
  mode: 'provider' as const,
  protocolBehavior: 'auto' as const,
  providerBinding: 'provider-a'
};

describe('provider-direct typed ErrorErr05 action consumption', () => {
  it('retries the same explicit default binding only after Rust returns WaitThenRetrySame', async () => {
    const sourceError = Object.assign(new Error('upstream 503'), {
      statusCode: 503,
      code: 'HTTP_503'
    });
    const processIncomingDirect = jest.fn()
      .mockRejectedValueOnce(sourceError)
      .mockResolvedValueOnce({ status: 200, body: { id: 'ok' } });
    const onProviderError = jest.fn(async () => plan('wait_then_retry_same'));

    const result = await executeProviderDirectPipeline(
      { model: 'gpt-5.5', input: 'hello' },
      '/v1/responses',
      {
        portConfig,
        resolveProvider: () => handleWith(processIncomingDirect),
        resolveInboundProtocol: resolveInboundProtocolFromEntryPath,
        onProviderError
      }
    );

    expect(result.response).toEqual({ status: 200, body: { id: 'ok' } });
    expect(processIncomingDirect).toHaveBeenCalledTimes(2);
    expect(onProviderError).toHaveBeenCalledTimes(1);
  });

  it('returns WaitThenReselect to the only caller instead of normalizing undefined', async () => {
    const sourceError = new Error('provider-a unavailable');
    const processIncomingDirect = jest.fn().mockRejectedValueOnce(sourceError);

    const result = await executeProviderDirectPipeline(
      { model: 'gpt-5.5', input: 'hello' },
      '/v1/responses',
      {
        portConfig,
        resolveProvider: () => handleWith(processIncomingDirect),
        resolveInboundProtocol: resolveInboundProtocolFromEntryPath,
        onProviderError: async () => plan('wait_then_reselect')
      }
    );

    expect(result.response).toBeUndefined();
    expect(result.sourceError).toBe(sourceError);
    expect(result.errorAction?.action).toBe('wait_then_reselect');
  });

  it.each([
    'project_terminal',
    'client_disconnected',
    'reject_non_provider_error'
  ] as const)('rethrows the source for terminal typed action %s', async (action) => {
    const sourceError = new Error(action);
    const processIncomingDirect = jest.fn().mockRejectedValueOnce(sourceError);

    await expect(executeProviderDirectPipeline(
      { model: 'gpt-5.5', input: 'hello' },
      '/v1/responses',
      {
        portConfig,
        resolveProvider: () => handleWith(processIncomingDirect),
        resolveInboundProtocol: resolveInboundProtocolFromEntryPath,
        onProviderError: async () => plan(action)
      }
    )).rejects.toBe(sourceError);
  });
});
