import { describe, expect, test } from '@jest/globals';

import {
  buildAnthropicRequestFromOpenAIChat,
  buildOpenAIChatFromAnthropic
} from '../../src/conversion/shared/anthropic-message-utils.js';

type AnyRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstBlockByType(content: unknown, type: string): AnyRecord | undefined {
  const blocks = asArray(content) as AnyRecord[];
  return blocks.find((entry) => entry && typeof entry === 'object' && String(entry.type || '').toLowerCase() === type);
}

describe('anthropic ↔ openai bridge roundtrip', () => {
  test('preserves model/system/roles/tools and tool_use↔tool_result identity', () => {
    const anthropicPayload: AnyRecord = {
      model: 'glm-anthropic-roundtrip',
      system: [{ type: 'text', text: 'You are a strict coding assistant.' }],
      tools: [
        {
          name: 'exec_command',
          description: 'run shell command',
          input_schema: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' }
            },
            required: ['cmd']
          }
        },
        {
          name: 'custom_tool',
          description: 'custom tool',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '请执行 echo hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'need to call tool' },
            { type: 'tool_use', id: 'toolu_roundtrip_1', name: 'exec_command', input: { cmd: 'echo hi' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_roundtrip_1', content: 'hi' }] }
      ]
    };

    const openai = buildOpenAIChatFromAnthropic(anthropicPayload, { includeToolCallIds: true }) as AnyRecord;
    const openaiMessages = asArray(openai.messages) as AnyRecord[];
    const assistantMsg = openaiMessages.find((m) => String(m.role || '').toLowerCase() === 'assistant') as AnyRecord;
    const toolMsg = openaiMessages.find((m) => String(m.role || '').toLowerCase() === 'tool') as AnyRecord;
    const toolCalls = asArray(assistantMsg?.tool_calls) as AnyRecord[];
    const firstToolCall = (toolCalls[0] || {}) as AnyRecord;
    const firstFn = (firstToolCall.function || {}) as AnyRecord;

    expect(openai.model).toBe('glm-anthropic-roundtrip');
    expect(asArray(openai.tools)).toHaveLength(2);
    expect(String(firstToolCall.id || '')).toBe('toolu_roundtrip_1');
    expect(String(firstFn.name || '')).toBe('exec_command');
    expect(String(toolMsg?.tool_call_id || '')).toBe('toolu_roundtrip_1');

    const roundtrip = buildAnthropicRequestFromOpenAIChat(openai) as AnyRecord;
    const roundtripSystem = asArray(roundtrip.system) as AnyRecord[];
    const roundtripMessages = asArray(roundtrip.messages) as AnyRecord[];
    const roleSeq = roundtripMessages.map((m) => String((m as AnyRecord).role || '').toLowerCase());
    const assistantRoundtrip = roundtripMessages.find((m) => String((m as AnyRecord).role || '') === 'assistant') as AnyRecord;
    const userToolResultRoundtrip = roundtripMessages[roundtripMessages.length - 1] as AnyRecord;
    const assistantThinking = firstBlockByType(assistantRoundtrip?.content, 'thinking');
    const assistantToolUse = firstBlockByType(assistantRoundtrip?.content, 'tool_use');
    const userToolResult = firstBlockByType(userToolResultRoundtrip?.content, 'tool_result');

    expect(roundtrip.model).toBe('glm-anthropic-roundtrip');
    expect(asArray(roundtrip.tools)).toHaveLength(2);
    expect(roleSeq).toEqual(['user', 'assistant', 'user']);
    expect(String((roundtripSystem[0] || {}).text || '')).toContain('strict coding assistant');
    expect(String(assistantThinking?.text || '')).toContain('need to call tool');
    expect(String(assistantToolUse?.id || '')).toBe('toolu_roundtrip_1');
    expect(String(assistantToolUse?.name || '')).toBe('exec_command');
    expect(String((assistantToolUse?.input as AnyRecord)?.cmd || '')).toContain('echo hi');
    expect(String(userToolResult?.tool_use_id || '')).toBe('toolu_roundtrip_1');
    expect(String(userToolResult?.content || '')).toContain('hi');
  });
});
