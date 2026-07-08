import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';

import { parsePendingToolSyncPayload } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.js';

async function importWithNativeParseFailureMock<TModule>(
  modulePath: string,
  bindingExport: string,
  invalidRaw = '{not-json'
): Promise<TModule> {
  jest.resetModules();

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.js',
    () => ({
      loadNativeRouterHotpathBindingForInternalUse: () => ({
        [bindingExport]: () => invalidRaw
      })
    })
  );

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js',
    () => ({
      isNativeDisabledByEnv: () => false,
      failNativeRequired: (_capability: string, reason?: string) => {
        throw new Error(`native-fail:${reason ?? 'unknown'}`);
      }
    })
  );

  return import(modulePath) as Promise<TModule>;
}

describe('native semantics parser observability', () => {
  it('logs router hotpath analysis parser JSON failures and still returns null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parsePendingToolSyncPayload('{not-json')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parsePendingToolSyncPayload parse failed (non-blocking)');

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

  it('logs inbound/outbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      collectToolOutputsWithNative: (payload: unknown) => Array<{ tool_call_id: string; call_id: string }>;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-inbound-outbound-semantics.js',
      'collectToolOutputsJson'
    );

    expect(() => mod.collectToolOutputsWithNative({})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseCollectedToolOutputs failed (non-blocking)');

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
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js',
      'normalizeHubEndpointJson'
    );

    expect(() => mod.normalizeHubEndpointWithNative('/v1/chat/completions')).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseString failed (non-blocking)');

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
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js',
      'normalizeProviderProtocolTokenJson'
    );

    expect(() => mod.normalizeProviderProtocolTokenWithNative('openai-chat')).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseOptionalString parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs req inbound tools parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      mapReqInboundBridgeToolsToChatWithNative: (rawTools: unknown) => Array<Record<string, unknown>>;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-tools.js',
      'mapBridgeToolsToChatJson'
    );

    expect(() => mod.mapReqInboundBridgeToolsToChatWithNative([])).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseArray parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs resp inbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      normalizeAliasMapWithNative: (candidate: unknown) => Record<string, string> | undefined;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.js',
      'normalizeAliasMapJson'
    );

    expect(() => mod.normalizeAliasMapWithNative({})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseAliasMap parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs resp outbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      evaluateResponsesHostPolicyWithNative: (context: unknown, targetProtocol?: string) => unknown;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-outbound-tools.js',
      'evaluateResponsesHostPolicyJson'
    );

    expect(() => mod.evaluateResponsesHostPolicyWithNative({})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseResponsesHostPolicyResult parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs bridge policy parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveBridgePolicyWithNative: (options?: { protocol?: string; moduleType?: string }) => unknown;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-policy-semantics.js',
      'resolveBridgePolicyJson'
    );

    expect(() => mod.resolveBridgePolicyWithNative({ protocol: 'openai-chat' })).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('resolveBridgePolicyWithNative parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs edge stage parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      sanitizeFormatEnvelopeWithNative: <T>(candidate: T) => T;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.js',
      'sanitizeFormatEnvelopeJson'
    );

    expect(() => mod.sanitizeFormatEnvelopeWithNative({ envelope: {} })).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseRecord failed (non-blocking)');

    warnSpy.mockRestore();
  });

});
