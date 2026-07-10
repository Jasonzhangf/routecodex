import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
});

async function importWithNativeParseFailureMock<TModule>(
  modulePath: string,
  bindingExport: string,
  invalidRaw = '{not-json'
): Promise<TModule> {
  jest.resetModules();

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js',
    () => ({
      isNativeDisabledByEnv: () => false,
      loadNativeRouterHotpathBindingForInternalUse: () => ({
        [bindingExport]: () => invalidRaw
      }),
      failNativeRequired: (_capability: string, reason?: string) => {
        throw new Error(`native-fail:${reason ?? 'unknown'}`);
      },
      failNative: (_capability: string, reason?: string) => {
        throw new Error(`native-fail:${reason ?? 'unknown'}`);
      },
      extractNativeErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error ?? ''),
      formatUnknownError: (error: unknown) =>
        error instanceof Error ? error.message : String(error ?? ''),
      callNativeJson: (
        _capability: string,
        _exportName: string,
        _args: string[],
        parse: (raw: string) => unknown
      ) => {
        const parsed = parse(invalidRaw);
        if (!parsed) throw new Error('native-fail:invalid payload');
        return parsed;
      },
      parseNativeJsonValueOrFail: (_capability: string, raw: string) => {
        try {
          return JSON.parse(raw);
        } catch {
          console.warn('resolveBridgePolicyWithNative parse failed (non-blocking): invalid payload');
          throw new Error('native-fail:invalid payload');
        }
      },
      parseNativeJsonObjectOrFail: (_capability: string, raw: string) => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('invalid payload');
          }
          return parsed;
        } catch {
          console.warn('resolveBridgePolicyWithNative parse failed (non-blocking): invalid payload');
          throw new Error('native-fail:invalid payload');
        }
      },
      readNativeFunction: (name: string) => {
        const binding = { [bindingExport]: () => invalidRaw } as Record<string, unknown>;
        const fn = binding[name];
        return typeof fn === 'function' ? fn : null;
      },
      safeStringify: (value: unknown) => JSON.stringify(value),
      stringifyNativePayloadForError: (value: unknown) => String(value ?? '')
    })
  );

  return import(modulePath) as Promise<TModule>;
}

async function importRouterHotpathWithNativeParseFailureMock<TModule>(
  bindingExport: string,
  invalidRaw = '{not-json'
): Promise<TModule> {
  jest.resetModules();

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js',
    () => ({
      isNativeDisabledByEnv: () => false,
      makeNativeRequiredError: (capability: string, reason?: string) =>
        new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable${reason ? `: ${reason}` : ''}`),
      loadNativeRouterHotpathBinding: () => ({
        [bindingExport]: () => invalidRaw
      }),
      loadNativeRouterHotpathBindingForInternalUse: () => ({
        [bindingExport]: () => invalidRaw
      }),
      callNativeJson: (
        capability: string,
        _exportName: string,
        _args: string[],
        parse: (raw: string) => unknown
      ) => {
        const parsed = parse(invalidRaw);
        if (!parsed) {
          throw new Error(`[virtual-router-native-hotpath] native ${capability} is required but unavailable: invalid payload`);
        }
        return parsed;
      },
      parseVirtualRouterNativeError: () => null
    })
  );

  return import('./helpers/native-router-hotpath-direct-native.js') as Promise<TModule>;
}

function warnCallsContain(warnSpy: jest.SpiedFunction<typeof console.warn>, expected: string): boolean {
  return warnSpy.mock.calls.some((call) => String(call[0] ?? '').includes(expected));
}

describe('native semantics parser observability', () => {
  it('logs router hotpath parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importRouterHotpathWithNativeParseFailureMock<{
      analyzePendingToolSync: (messages: unknown[], afterToolCallIds: string[]) => unknown;
    }>('analyzePendingToolSyncJson');

    expect(() => mod.analyzePendingToolSync([], [])).toThrow(/native analyzePendingToolSyncJson is required but unavailable: invalid payload/);
    expect(warnCallsContain(warnSpy, 'parsePendingToolSyncPayload parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('keeps retired chat-process governance parser wrappers deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('keeps retired req outbound parser facade deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics-parsers.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('keeps retired req inbound parser facade deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-parsers.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('keeps retired resp parser facade deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-parsers.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('keeps retired chat-process servertool orchestration parser wrappers deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('logs req inbound collected tool output parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      collectToolOutputsWithNative: (payload: unknown) => Array<{ tool_call_id: string; call_id: string }>;
    }>(
      './helpers/req-inbound-direct-native.js',
      'collectToolOutputsJson'
    );

    expect(() => mod.collectToolOutputsWithNative({})).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseCollectedToolOutputs parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('keeps retired metadata policy parser wrapper deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-metadata-policy.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('logs protocol parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      normalizeHubEndpointWithNative: (endpoint: string) => string;
    }>(
      './helpers/hub-pipeline-orchestration-direct-native.js',
      'normalizeHubEndpointJson'
    );

    expect(() => mod.normalizeHubEndpointWithNative('/v1/chat/completions')).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseString failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('keeps retired req outbound aggregate parser wrapper deleted', () => {
    const retiredWrapperPath = new URL(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts',
      import.meta.url
    );

    expect(() => fs.statSync(retiredWrapperPath)).toThrow();
  });

  it('logs req inbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      normalizeProviderProtocolTokenWithNative: (value: string | undefined) => string | undefined;
    }>(
      './helpers/req-inbound-direct-native.js',
      'normalizeProviderProtocolTokenJson'
    );

    expect(() => mod.normalizeProviderProtocolTokenWithNative('openai-chat')).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseOptionalString parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs req inbound tool parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      mapReqInboundBridgeToolsToChatWithNative: (rawTools: unknown) => Array<Record<string, unknown>>;
    }>(
      './helpers/req-inbound-direct-native.js',
      'mapBridgeToolsToChatJson'
    );

    expect(() => mod.mapReqInboundBridgeToolsToChatWithNative([])).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseArray parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs resp inbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      normalizeAliasMapWithNative: (candidate: unknown) => Record<string, string> | undefined;
    }>(
      './helpers/resp-semantics-direct-native.js',
      'normalizeAliasMapJson'
    );

    expect(() => mod.normalizeAliasMapWithNative({})).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseAliasMap parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs resp outbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      evaluateResponsesHostPolicyWithNative: (context: unknown, targetProtocol?: string) => unknown;
    }>(
      './helpers/resp-semantics-direct-native.js',
      'evaluateResponsesHostPolicyJson'
    );

    expect(() => mod.evaluateResponsesHostPolicyWithNative({})).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseResponsesHostPolicyResult parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs bridge policy parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveBridgePolicyWithNative: (options?: { protocol?: string; moduleType?: string }) => unknown;
    }>(
      './helpers/native-hub-bridge-policy-direct-native.js',
      'resolveBridgePolicyJson'
    );

    expect(() => mod.resolveBridgePolicyWithNative({ protocol: 'openai-chat' })).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'resolveBridgePolicyWithNative parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs edge stage parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      sanitizeFormatEnvelopeWithNative: <T>(candidate: T) => T;
    }>(
      './helpers/req-inbound-direct-native.js',
      'sanitizeFormatEnvelopeJson'
    );

    expect(() => mod.sanitizeFormatEnvelopeWithNative({ envelope: {} })).toThrow('native-fail:invalid payload');
    expect(warnCallsContain(warnSpy, 'parseRecord parse failed (non-blocking)')).toBe(true);

    warnSpy.mockRestore();
  });

});
