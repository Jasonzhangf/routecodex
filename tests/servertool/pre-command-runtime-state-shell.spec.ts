import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const loadRoutingInstructionStateSync = jest.fn();
const planRuntimePreCommandStateRuntimeActionWithNative = jest.fn();
const resolveServertoolPersistentScopeKey = jest.fn(() => null);
const createServertoolProviderProtocolErrorFromPlan = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js',
  () => ({
    loadRoutingInstructionStateSync
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planRuntimePreCommandStateRuntimeActionWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/state-scope.js',
  () => ({
    resolveServertoolPersistentScopeKey
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan
  })
);

const { resolveServertoolRuntimePreCommandState } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.js'
);

describe('pre-command-runtime-state-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planRuntimePreCommandStateRuntimeActionWithNative.mockImplementation((input: any) => {
      const direct = input?.directRuntimePreCommandState;
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
        return { action: 'use_selected', state: direct };
      }
      const runtime = input?.runtimeMetadataPreCommandState;
      if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
        return { action: 'use_selected', state: runtime };
      }
      if (typeof input?.persistedLoadError === 'string' && input.persistedLoadError.trim()) {
        return {
          action: 'throw_state_load_failed',
          errorPlan: {
            code: 'SERVERTOOL_STATE_LOAD_FAILED',
            category: 'INTERNAL_ERROR',
            status: 500,
            message: `[servertool] sticky routing state load failed: ${String(input?.stickyKey ?? '')}: ${String(input?.persistedLoadError ?? '')}`,
            details: {
              stickyKey: String(input?.stickyKey ?? ''),
              requestId: String(input?.requestId ?? '')
            }
          }
        };
      }
      if (!input?.persistedLoadAttempted && input?.hasPersistentScopeKey) {
        return { action: 'load_persisted' };
      }
      return {
        action: 'use_selected',
        state:
          input?.persistedState && typeof input.persistedState === 'object' && !Array.isArray(input.persistedState)
            ? input.persistedState
            : undefined
      };
    });
    createServertoolProviderProtocolErrorFromPlan.mockImplementation((plan: any) => {
      const err = new Error(String(plan?.message ?? 'state load failed'));
      (err as Error & { code?: string; status?: number; details?: unknown }).code = plan?.code;
      (err as Error & { code?: string; status?: number; details?: unknown }).status = plan?.status;
      (err as Error & { code?: string; status?: number; details?: unknown }).details = plan?.details;
      return err;
    });
  });

  test('uses direct runtime preCommandState without persisted load', () => {
    const state = resolveServertoolRuntimePreCommandState({
      adapterContext: { __rt: { preCommandState: { routeHint: 'web_search' } } },
      runtimeMetadata: undefined,
      requestId: 'req-direct'
    });

    expect(state).toEqual({ routeHint: 'web_search' });
    expect(loadRoutingInstructionStateSync).not.toHaveBeenCalled();
    expect(planRuntimePreCommandStateRuntimeActionWithNative).toHaveBeenCalledWith({
      directRuntimePreCommandState: { routeHint: 'web_search' },
      runtimeMetadataPreCommandState: undefined,
      hasPersistentScopeKey: false,
      persistedLoadAttempted: false
    });
  });

  test('uses runtime metadata preCommandState without persisted load', () => {
    const state = resolveServertoolRuntimePreCommandState({
      adapterContext: {},
      runtimeMetadata: { preCommandState: { routeHint: 'multimodal' } },
      requestId: 'req-metadata'
    });

    expect(state).toEqual({ routeHint: 'multimodal' });
    expect(loadRoutingInstructionStateSync).not.toHaveBeenCalled();
  });

  test('loads persisted state when native runtime action asks for it', () => {
    resolveServertoolPersistentScopeKey.mockReturnValue('session:pre-command');
    loadRoutingInstructionStateSync.mockReturnValue({ routeHint: 'thinking' });

    const state = resolveServertoolRuntimePreCommandState({
      adapterContext: {},
      runtimeMetadata: undefined,
      requestId: 'req-persisted',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(resolveServertoolPersistentScopeKey).toHaveBeenCalledWith({});
    expect(loadRoutingInstructionStateSync).toHaveBeenCalledWith('session:pre-command');
    expect(planRuntimePreCommandStateRuntimeActionWithNative).toHaveBeenNthCalledWith(2, {
      directRuntimePreCommandState: undefined,
      runtimeMetadataPreCommandState: undefined,
      hasPersistentScopeKey: true,
      persistedState: { routeHint: 'thinking' },
      persistedLoadAttempted: true
    });
    expect(state).toEqual({ routeHint: 'thinking' });
  });

  test('throws wrapped state-load-failed error when persisted read crashes', () => {
    resolveServertoolPersistentScopeKey.mockReturnValue('session:pre-command-fail');
    loadRoutingInstructionStateSync.mockImplementation(() => {
      throw new Error('disk unavailable');
    });

    expect(() =>
      resolveServertoolRuntimePreCommandState({
        adapterContext: {},
        runtimeMetadata: undefined,
        requestId: 'req-error',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai'
      })
    ).toThrow('[servertool] sticky routing state load failed: session:pre-command-fail: disk unavailable');
    expect(planRuntimePreCommandStateRuntimeActionWithNative).toHaveBeenNthCalledWith(2, {
      directRuntimePreCommandState: undefined,
      runtimeMetadataPreCommandState: undefined,
      hasPersistentScopeKey: true,
      persistedLoadAttempted: true,
      persistedLoadError: 'disk unavailable',
      requestId: 'req-error',
      stickyKey: 'session:pre-command-fail',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai'
    });
  });
});
