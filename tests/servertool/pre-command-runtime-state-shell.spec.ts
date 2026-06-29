import fs from 'node:fs';

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

function bindProviderProtocol(adapterContext: Record<string, unknown>, providerProtocol = 'openai-responses'): void {
  Reflect.set(adapterContext, METADATA_CENTER_SYMBOL, {
    readRuntimeControl: () => ({ providerProtocol })
  });
}

function bindRuntimeControl(adapterContext: Record<string, unknown>, runtimeControl: Record<string, unknown>): void {
  Reflect.set(adapterContext, METADATA_CENTER_SYMBOL, {
    readRuntimeControl: () => runtimeControl
  });
}

const planRuntimePreCommandStateRuntimeActionWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planRuntimePreCommandStateRuntimeActionWithNative
  })
);

const { resolveServertoolRuntimePreCommandState } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.js'
);

describe('pre-command-runtime-state-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planRuntimePreCommandStateRuntimeActionWithNative.mockImplementation((input: any) => {
      const state = input?.runtimeControlPreCommandState;
      return {
        action: 'use_selected',
        source: state && typeof state === 'object' && !Array.isArray(state) ? 'runtime_control' : 'none',
        state: state && typeof state === 'object' && !Array.isArray(state) ? state : undefined
      };
    });
  });

  test('uses metadata center runtime_control preCommandState', () => {
    const adapterContext: Record<string, unknown> = {};
    bindRuntimeControl(adapterContext, {
      preCommandState: { routeHint: 'web_search' }
    });
    const state = resolveServertoolRuntimePreCommandState({
      adapterContext,
      requestId: 'req-direct'
    });

    expect(state).toEqual({ routeHint: 'web_search' });
    expect(planRuntimePreCommandStateRuntimeActionWithNative).toHaveBeenCalledWith({
      runtimeControlPreCommandState: { routeHint: 'web_search' }
    });
  });

  test('source does not read legacy runtime metadata preCommandState', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('__rt');
    expect(source).not.toContain('readRuntimeMetadata(');
    expect(source).toContain('readRuntimeControlFromAnyBoundMetadataCenter');
  });

  test('does not load persisted routing state for preCommandState', () => {
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-responses');

    const state = resolveServertoolRuntimePreCommandState({
      adapterContext,
      requestId: 'req-persisted',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(planRuntimePreCommandStateRuntimeActionWithNative).toHaveBeenCalledWith({
      runtimeControlPreCommandState: undefined
    });
    expect(state).toBeUndefined();
  });
});
