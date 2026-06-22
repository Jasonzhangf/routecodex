import { describe, expect, test } from '@jest/globals';
import {
  asServertoolJsonObject,
  resolveServertoolEntryContext
} from '../../sharedmodule/llmswitch-core/src/servertool/entry-context-shell.js';

describe('entry-context-shell', () => {
  test('owns entry json-object coercion and filter normalization', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/entry-context-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('export function resolveServertoolEntryContext(');
    expect(source).toContain('export function asServertoolJsonObject(');
    expect(source).toContain('normalizeFilterTokenSet');
  });

  test('builds context base and normalized include/exclude sets', () => {
    const result = resolveServertoolEntryContext({
      options: {
        adapterContext: { req: true },
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

  test('returns null for non-object payloads', () => {
    expect(asServertoolJsonObject(null)).toBeNull();
    expect(asServertoolJsonObject([])).toBeNull();
    expect(asServertoolJsonObject('x')).toBeNull();
    expect(asServertoolJsonObject({ ok: true })).toEqual({ ok: true });
  });
});
