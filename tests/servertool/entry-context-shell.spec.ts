import { describe, expect, test } from '@jest/globals';
import {
  asServertoolJsonObject,
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
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/entry-context-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('export function resolveServertoolEntryContext(');
    expect(source).toContain('export function asServertoolJsonObject(');
    expect(source).toContain('planServertoolEntryContextWithNative');
    expect(source).not.toContain('function normalizeFilterTokenSet(');
    expect(source).not.toContain('.trim().toLowerCase()');
  });

  test('builds context base and normalized include/exclude sets', () => {
    const adapterContext: Record<string, unknown> = { req: true };
    bindProviderProtocol(adapterContext, 'openai-responses');
    const result = resolveServertoolEntryContext({
      options: {
        adapterContext,
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
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
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      }
    });
    expect(result.action === 'continue' ? [...(result.includeToolCallNames ?? [])] : []).toEqual(['web_search']);
    expect(result.action === 'continue' ? [...(result.excludeToolCallNames ?? [])] : []).toEqual(['vision_auto']);
    expect(result.action === 'continue' ? [...(result.includeAutoHookIds ?? [])] : []).toEqual(['stop_message_auto']);
    expect(result.action === 'continue' ? result.excludeAutoHookIds : null).toBeNull();
  });

  test('fails fast when metadata center runtimeControl.providerProtocol is absent', () => {
    expect(() => resolveServertoolEntryContext({
      options: {
        adapterContext: {},
        requestId: 'req-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      base: { ok: true } as any
    })).toThrow('Servertool entry context requires metadata center runtime_control.providerProtocol');
  });

  test('returns null for non-object payloads', () => {
    expect(asServertoolJsonObject(null)).toBeNull();
    expect(asServertoolJsonObject([])).toBeNull();
    expect(asServertoolJsonObject('x')).toBeNull();
    expect(asServertoolJsonObject({ ok: true })).toEqual({ ok: true });
  });

  test('prefers bound metadata center runtimeControl.providerProtocol over explicit options.providerProtocol', () => {
    const adapterContext: Record<string, unknown> = {};
    const center = MetadataCenter.attach(adapterContext);
    center.writeRuntimeControl(
      'providerProtocol',
      'anthropic-messages',
      {
        module: 'tests/servertool/entry-context-shell.spec.ts',
        symbol: 'prefers bound metadata center runtimeControl.providerProtocol over explicit options.providerProtocol',
        stage: 'test'
      }
    );

    const result = resolveServertoolEntryContext({
      options: {
        adapterContext,
        requestId: 'req-1',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat'
      } as any,
      toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }],
      base: { ok: true } as any
    });

    expect(result).toMatchObject({
      action: 'continue',
      contextBase: {
        providerProtocol: 'anthropic-messages'
      }
    });
  });
});
