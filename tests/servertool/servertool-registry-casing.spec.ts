import { describe, expect, test } from '@jest/globals';
import {
  getServerToolHandler,
  isRegisteredServerToolName
} from '../../sharedmodule/llmswitch-core/src/servertool/registry.js';

describe('servertool registry casing', () => {
  test('camelCase builtin reasoningStop resolves to a concrete tool_call handler', () => {
    expect(isRegisteredServerToolName('reasoningStop')).toBe(true);
    expect(getServerToolHandler('reasoningStop')).toMatchObject({
      name: 'reasoningStop',
      trigger: 'tool_call',
      registration: {
        name: 'reasoningStop',
        trigger: 'tool_call',
        executionMode: 'guarded'
      }
    });
  });
});
