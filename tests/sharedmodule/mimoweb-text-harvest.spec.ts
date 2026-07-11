import { describe, expect, it } from '@jest/globals';

import { normalizeAssistantTextToToolCallsWithNative } from './helpers/native-shared-conversion-direct-native.js';

describe('mimoweb text harvest uses shared native normalizer', () => {
  it('harvests mimoweb tool_call json wrapper through native ssot', async () => {
    const out = normalizeAssistantTextToToolCallsWithNative({
      role: 'assistant',
      content: '<tool_call>\n{"name":"read","arguments":{"filePath":"/tmp/a.txt"}}\n</tool_call>'
    });

    expect(out.tool_calls).toHaveLength(1);
    expect((out.tool_calls as any[])[0]?.function?.name).toBe('read');
    expect(JSON.parse(String((out.tool_calls as any[])[0]?.function?.arguments))).toEqual({
      filePath: '/tmp/a.txt'
    });
    expect(String(out.content || '')).toBe('');
  });

  it('does not turn think tags into tool calls', async () => {
    const out = normalizeAssistantTextToToolCallsWithNative({
      role: 'assistant',
      content: '<think>I should inspect the request first.</think>我会继续处理。'
    });

    expect(Array.isArray(out.tool_calls) ? out.tool_calls : []).toHaveLength(0);
    expect(String(out.content || '')).toContain('<think>');
  });

  it('does not harvest plain function_calls wrapper when inner body is only bash prose', async () => {
    const out = normalizeAssistantTextToToolCallsWithNative({
      role: 'assistant',
      content: '<function_calls>```bash\npwd\n```</function_calls>'
    });

    expect(Array.isArray(out.tool_calls) ? out.tool_calls : []).toHaveLength(0);
    expect(String(out.content || '')).toContain('```bash');
  });
});
