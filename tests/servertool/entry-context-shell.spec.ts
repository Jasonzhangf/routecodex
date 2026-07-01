import { describe, expect, test } from '@jest/globals';
import {
  resolveServertoolEntryContext
} from '../../sharedmodule/llmswitch-core/src/servertool/entry-context-shell.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindProviderProtocol(adapterContext: Record<string, unknown>, providerProtocol = 'openai-responses'): void {
  const center = MetadataCenter.attach(adapterContext);
  if (!center.readRuntimeControl().providerProtocol) {
    center.writeRuntimeControl(
      'providerProtocol',
      providerProtocol,
      {
        module: 'tests/servertool/entry-context-shell.spec.ts',
        symbol: 'bindProviderProtocol',
        stage: 'test'
      }
    );
  }
}

describe('entry-context-shell', () => {
  test('keeps entry shell thin and delegates filter normalization to native Rust', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/entry-context-shell.ts',
      'utf8'
    );
    const typesSource = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/types.ts',
      'utf8'
    );

    expect(source).toContain('export function resolveServertoolEntryContext(');
    expect(source).toContain('planServertoolEntryContextWithNative');
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain('Servertool entry context requires metadata center runtime_control.providerProtocol');
    expect(source).not.toContain('export function asServertoolJsonObject(');
    expect(source).not.toContain('function tokenSetFromNativePlan(');
    expect(source).not.toContain('entryContextPlan.includeToolCallNames.length > 0');
    expect(source).not.toContain('entryContextPlan.excludeToolCallNames.length > 0');
    expect(source).not.toContain('entryContextPlan.includeAutoHookIds.length > 0');
    expect(source).not.toContain('entryContextPlan.excludeAutoHookIds.length > 0');
    expect(source).not.toContain('.trim().toLowerCase()');
    expect(source).not.toContain('return tokens ? new Set(tokens) : null;');
    expect(source).toContain('return tokens != null ? new Set(tokens) : null;');
    expect(typesSource).not.toMatch(/export interface ServerSideToolEngineOptions\s*\{[\s\S]{0,260}providerProtocol:\s*string;/);
  });

  test('builds context base and normalized include/exclude sets', () => {
    const adapterContext: Record<string, unknown> = { req: true };
    bindProviderProtocol(adapterContext, 'openai-responses');
    const result = resolveServertoolEntryContext({
      options: {
        adapterContext,
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        includeToolCallHandlerNames: [' Web_Search ', '', 'web_search'],
        excludeToolCallHandlerNames: [' Vision_Auto '],
        includeAutoHookIds: [' Stop_Message_Auto '],
        excludeAutoHookIds: []
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      base: { ok: true } as any
    });

    expect(result).toMatchObject({
      action: 'continue',
      baseObject: { ok: true },
      contextBase: {
        requestId: 'req-1',
        entryEndpoint: '/v1/responses'
      }
    });
    expect(result.action === 'continue' ? [...(result.includeToolCallNames ?? [])] : []).toEqual(['web_search']);
    expect(result.action === 'continue' ? [...(result.excludeToolCallNames ?? [])] : []).toEqual(['vision_auto']);
    expect(result.action === 'continue' ? [...(result.includeAutoHookIds ?? [])] : []).toEqual(['stop_message_auto']);
    expect(result.action === 'continue' ? result.excludeAutoHookIds : null).toBeNull();
  });

  test('fails fast when metadata center snapshot is absent', () => {
    expect(() => resolveServertoolEntryContext({
      options: {
        adapterContext: {},
        requestId: 'req-1',
        entryEndpoint: '/v1/responses'
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      base: { ok: true } as any
    })).toThrow('Servertool entry context requires MetadataCenter request truth or runtime_control snapshot');
  });

  test('uses only bound metadata center runtimeControl.providerProtocol', () => {
    const adapterContext: Record<string, unknown> = {};
    const center = MetadataCenter.attach(adapterContext);
    center.writeRuntimeControl(
      'providerProtocol',
      'anthropic-messages',
      {
        module: 'tests/servertool/entry-context-shell.spec.ts',
        symbol: 'uses only bound metadata center runtimeControl.providerProtocol',
        stage: 'test'
      }
    );

    const result = resolveServertoolEntryContext({
      options: {
        adapterContext,
        requestId: 'req-1',
        entryEndpoint: '/v1/messages'
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      base: { ok: true } as any
    });

    expect(result).toMatchObject({
      action: 'continue',
      contextBase: {
        entryEndpoint: '/v1/messages'
      }
    });
  });
});
