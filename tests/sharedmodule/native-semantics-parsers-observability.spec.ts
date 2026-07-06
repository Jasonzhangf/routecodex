import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';

import { parseAliasMap } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-parsers.js';
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
    '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-policy.js',
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
  it('logs resp semantics parser JSON failures and still preserves null contract', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseAliasMap('{not-json')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseAliasMap parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

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

  it('logs metadata policy parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveStopMessageRouterMetadataWithNative: (
        metadata: Record<string, unknown> | undefined
      ) => Record<string, unknown>;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-metadata-policy.js',
      'resolveStopMessageRouterMetadataJson'
    );

    expect(() => mod.resolveStopMessageRouterMetadataWithNative({})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseStopMessageRouterMetadata failed (non-blocking)');

    warnSpy.mockRestore();
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

  it('logs req outbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      applyClaudeThinkingToolSchemaCompatWithNative: (payload: Record<string, unknown>) => Record<string, unknown>;
    }>(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js',
      'applyClaudeThinkingToolSchemaCompatJson'
    );

    expect(() => mod.applyClaudeThinkingToolSchemaCompatWithNative({ tools: [] })).toThrow(
      'native applyClaudeThinkingToolSchemaCompatJson execution failed: invalid payload'
    );
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseJsonObject parse failed (non-blocking)');

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
