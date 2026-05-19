import { describe, expect, test } from '@jest/globals';
import {
  saveOriginSnapshot,
  loadOriginSnapshot,
  hasOriginSnapshot,
  clearOriginSnapshot,
  type OriginSnapshot
} from '../../sharedmodule/llmswitch-core/src/servertool/origin-request-store.js';

const SESSION_ID = 'sess_origin_test_1';

function makeSnapshot(overrides?: Partial<OriginSnapshot>): Omit<OriginSnapshot, 'savedAt'> {
  return {
    requestId: 'req_origin_test',
    sessionScope: SESSION_ID,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
    parameters: { temperature: 0.7 },
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    capturedChatRequest: {
      model: 'gpt-4o',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }]
        }
      ]
    },
    ...overrides
  };
}

describe('origin-request-store', () => {
  test('saveOriginSnapshot writes and loadOriginSnapshot reads back', () => {
    clearOriginSnapshot(SESSION_ID);
    const snap = makeSnapshot();
    const ok = saveOriginSnapshot(SESSION_ID, snap);
    expect(ok).toBe(true);

    const loaded = loadOriginSnapshot(SESSION_ID);
    expect(loaded).toBeTruthy();
    expect(loaded!.model).toBe('gpt-4o');
    expect(loaded!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(loaded!.sessionScope).toBe(SESSION_ID);
    expect(typeof loaded!.savedAt).toBe('number');
  });

  test('saveOriginSnapshot returns false for empty session scope (fail-fast)', () => {
    const ok = saveOriginSnapshot('', makeSnapshot());
    expect(ok).toBe(false);
  });

  test('loadOriginSnapshot returns undefined when not found', () => {
    clearOriginSnapshot('sess_not_exist');
    const loaded = loadOriginSnapshot('sess_not_exist');
    expect(loaded).toBeUndefined();
  });

  test('hasOriginSnapshot returns correct presence', () => {
    clearOriginSnapshot(SESSION_ID);
    expect(hasOriginSnapshot(SESSION_ID)).toBe(false);

    saveOriginSnapshot(SESSION_ID, makeSnapshot());
    expect(hasOriginSnapshot(SESSION_ID)).toBe(true);
  });

  test('clearOriginSnapshot removes stored snapshot', () => {
    saveOriginSnapshot(SESSION_ID, makeSnapshot());
    expect(hasOriginSnapshot(SESSION_ID)).toBe(true);

    clearOriginSnapshot(SESSION_ID);
    expect(hasOriginSnapshot(SESSION_ID)).toBe(false);
    expect(loadOriginSnapshot(SESSION_ID)).toBeUndefined();
  });

  test('saveOriginSnapshot overwrites previous snapshot for same scope', () => {
    clearOriginSnapshot(SESSION_ID);
    saveOriginSnapshot(SESSION_ID, makeSnapshot({ model: 'gpt-4o' }));
    saveOriginSnapshot(SESSION_ID, makeSnapshot({ model: 'gpt-4-turbo' }));

    const loaded = loadOriginSnapshot(SESSION_ID);
    expect(loaded!.model).toBe('gpt-4-turbo');
  });

  test('snapshot keeps raw capturedChatRequest for followup rebuild', () => {
    clearOriginSnapshot(SESSION_ID);
    saveOriginSnapshot(
      SESSION_ID,
      makeSnapshot({
        capturedChatRequest: {
          model: 'gpt-5.3-codex',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
        } as any
      })
    );
    const loaded = loadOriginSnapshot(SESSION_ID);
    expect(loaded?.capturedChatRequest).toBeTruthy();
    expect((loaded?.capturedChatRequest as any)?.model).toBe('gpt-5.3-codex');
    expect(Array.isArray((loaded?.capturedChatRequest as any)?.input)).toBe(true);
  });
});
