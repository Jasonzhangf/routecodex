import { describe, expect, it, jest } from '@jest/globals';

import { parseOutput } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-action-semantics-parsers.js';
import { parseAliasMap } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics-parsers.js';
import { parseBoolean as parseReqInboundBoolean } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics-parsers.js';
import { parseBoolean as parseReqOutboundBoolean } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics-parsers.js';
import { parsePendingToolSyncPayload } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-analysis.js';

async function importWithNativeParseFailureMock<TModule>(
  modulePath: string,
  bindingExport: string,
  invalidRaw = '{not-json'
): Promise<TModule> {
  jest.resetModules();

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath.js',
    () => ({
      loadNativeRouterHotpathBindingForInternalUse: () => ({
        [bindingExport]: () => invalidRaw
      })
    })
  );

  jest.unstable_mockModule(
    '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-policy.js',
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
  it('logs bridge action parser JSON failures and still returns null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseOutput('{not-json')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseOutput parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

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

  it('logs req outbound parser JSON failures and still returns null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseReqOutboundBoolean('{not-json')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseBoolean parse failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs req inbound parser JSON failures and still returns null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseReqInboundBoolean('{not-json')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseBoolean failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs governance parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      buildAnthropicToolAliasMapWithNative: (tools: unknown) => Record<string, unknown> | undefined;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.js',
      'buildAnthropicToolAliasMapJson'
    );

    expect(() => mod.buildAnthropicToolAliasMapWithNative([])).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseAliasMapPayload failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs servertool orchestration parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      planChatWebSearchOperationsWithNative: (
        request: unknown,
        runtimeMetadata: Record<string, unknown>
      ) => { shouldInject: boolean; selectedEngineIndexes: number[] };
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js',
      'planChatWebSearchOperationsJson'
    );

    expect(() => mod.planChatWebSearchOperationsWithNative({}, {})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseWebSearchPlan failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs inbound/outbound parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      mapResumeToolOutputsDetailedWithNative: (responsesResume: unknown) => Array<{ tool_call_id: string; content: string }>;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-inbound-outbound-semantics.js',
      'mapResumeToolOutputsDetailedJson'
    );

    expect(() => mod.mapResumeToolOutputsDetailedWithNative({})).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseResumeToolOutputs failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs clock reminder parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveClockConfigWithNative: (
        raw: unknown,
        rawIsUndefined: boolean
      ) => Record<string, unknown> | null;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js',
      'resolveClockConfigJson'
    );

    expect(() => mod.resolveClockConfigWithNative({}, false)).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseClockConfigOrNull failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs metadata policy parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveStopMessageRouterMetadataWithNative: (
        metadata: Record<string, unknown> | undefined
      ) => Record<string, unknown>;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-metadata-policy.js',
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
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js',
      'normalizeHubEndpointJson'
    );

    expect(() => mod.normalizeHubEndpointWithNative('/v1/chat/completions')).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseString failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs bridge policy parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveBridgePolicyWithNative: (options?: { protocol?: string; moduleType?: string }) => unknown;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.js',
      'resolveBridgePolicyJson'
    );

    expect(() => mod.resolveBridgePolicyWithNative({ protocol: 'openai-chat' })).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parsePolicy failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs edge stage parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      sanitizeFormatEnvelopeWithNative: <T>(candidate: T) => T;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js',
      'sanitizeFormatEnvelopeJson'
    );

    expect(() => mod.sanitizeFormatEnvelopeWithNative({ envelope: {} })).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseRecord failed (non-blocking)');

    warnSpy.mockRestore();
  });

  it('logs passthrough parser JSON failures before fail-fasting native capability', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await importWithNativeParseFailureMock<{
      resolveHasInstructionRequestedPassthroughWithNative: (messages: unknown) => boolean;
    }>(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-passthrough.js',
      'resolveHasInstructionRequestedPassthroughJson'
    );

    expect(() => mod.resolveHasInstructionRequestedPassthroughWithNative([])).toThrow('native-fail:invalid payload');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('parseBoolean failed (non-blocking)');

    warnSpy.mockRestore();
  });
});
