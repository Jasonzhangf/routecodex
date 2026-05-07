import { describe, expect, it } from '@jest/globals';
import { serializeMessages } from '../../../../src/providers/core/runtime/mimoweb/mimoweb-serialize.js';

describe('mimoweb serialize', () => {
  it('keeps full non-system history without local replay truncation', () => {
    const messages = Array.from({ length: 45 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${index}`
    })) as Array<{ role: 'user' | 'assistant'; content: string }>;

    const { query } = serializeMessages(messages);

    expect(query).toContain('user: msg-0');
    expect(query).toContain('assistant: msg-1');
    expect(query).toContain('user: msg-44');
  });

  it('serializes assistant tool_use blocks as reference-style tool_call wrappers', () => {
    const { query } = serializeMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'read',
            input: { filePath: '/etc/hosts' }
          }
        ]
      }
    ]);

    expect(query).toContain('<tool_call>');
    expect(query).toContain('"name":"read"');
    expect(query).toContain('"arguments":{"filePath":"/etc/hosts"}');
    expect(query).toContain('</tool_call>');
    expect(query).not.toContain('"id":');
  });

  it('serializes openai assistant tool_calls and tool messages into mimoweb text history', () => {
    const { query } = serializeMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'read',
              arguments: JSON.stringify({ filePath: '/tmp/a.txt' })
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'read',
        content: 'A_CONTENT'
      }
    ] as any);

    expect(query).toContain('assistant: <tool_call>');
    expect(query).toContain('"name":"read"');
    expect(query).toContain('"arguments":{"filePath":"/tmp/a.txt"}');
    expect(query).toContain('user: [工具结果]');
    expect(query).toContain('A_CONTENT');
  });

  it('serializes user tool_result blocks in reference-style plain text', () => {
    const { query } = serializeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: '127.0.0.1 localhost' }
            ]
          }
        ]
      }
    ]);

    expect(query).toContain('user: [工具结果]');
    expect(query).toContain('127.0.0.1 localhost');
    expect(query).not.toContain('<tool_result>');
  });

  it('preserves multiple tool_result contents without XML wrapping', () => {
    const { query } = serializeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_a',
            content: 'A_CONTENT'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            content: 'B_CONTENT'
          }
        ]
      }
    ] as Array<{ role: 'user'; content: any }>);

    expect(query).toContain('A_CONTENT');
    expect(query).toContain('B_CONTENT');
    expect(query.match(/\[工具结果\]/g)?.length ?? 0).toBe(2);
    expect(query).not.toContain('<tool_result>');
  });
});
