import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  createReplayChatOwner,
  ensureReplayChatModel,
  replaceSystemMessages
} from '../../scripts/tools/responses-provider-replay.mjs';

describe('responses-provider replay payload copy budget', () => {
  test('source rejects JSON round-trip replay payload clones', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/tools/responses-provider-replay.mjs'),
      'utf8'
    );

    expect(source).not.toContain('function deepClone');
    expect(source).not.toContain('JSON.parse(JSON.stringify');
    expect(source).not.toContain('deepClone(');
  });

  test('creates only a shallow replay owner for chat payload mutation', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const tools = [{ type: 'function', function: { name: 'search' } }];
    const source = { messages, tools, metadata: { trace: { id: 'trace_1' } } };

    const replay = createReplayChatOwner(source);

    expect(replay).not.toBe(source);
    expect(replay.messages).toBe(messages);
    expect(replay.tools).toBe(tools);
    expect(replay.metadata).toBe(source.metadata);
  });

  test('model defaulting does not mutate the captured sample payload', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const source = { messages };

    const replay = ensureReplayChatModel(source, 'gpt-replay');

    expect(source).toEqual({ messages });
    expect(replay).toEqual({ messages, model: 'gpt-replay' });
    expect(replay.messages).toBe(messages);
  });

  test('system replacement rewrites only top-level chat ownership', () => {
    const userMessage = { role: 'user', content: 'hello' };
    const oldSystem = { role: 'system', content: 'old' };
    const source = { model: 'gpt-replay', messages: [oldSystem, userMessage] };

    const replay = replaceSystemMessages(source, ['new']);

    expect(replay).not.toBe(source);
    expect(replay.messages).not.toBe(source.messages);
    expect(replay.messages).toEqual([
      { role: 'system', content: 'new' },
      userMessage
    ]);
    expect(source.messages).toEqual([oldSystem, userMessage]);
  });
});
