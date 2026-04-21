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

  test('preserves input_image blocks when bridging openai chat into anthropic request', () => {
    const openaiPayload: AnyRecord = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR4nGP8z0AaYCJRPcOoBmIAE1GqkMCoBmIAyaEEAEAuAR9UPEsJAAAAAElFTkSuQmCC'
            }
          ]
        }
      ]
    };

    const anthropicRequest = buildAnthropicRequestFromOpenAIChat(openaiPayload) as AnyRecord;
    const anthropicMessages = asArray(anthropicRequest.messages) as AnyRecord[];
    const userMessage = anthropicMessages[0] as AnyRecord;
    const imageBlock = firstBlockByType(userMessage?.content, 'image');

    expect(String(userMessage?.role || '')).toBe('user');
    expect(firstBlockByType(userMessage?.content, 'text')).toEqual({
      type: 'text',
      text: 'describe this image'
    });
    expect(imageBlock).toBeTruthy();
    expect(String((imageBlock?.source as AnyRecord)?.type || '')).toBe('base64');
    expect(String((imageBlock?.source as AnyRecord)?.media_type || '')).toBe('image/png');
    expect(String((imageBlock?.source as AnyRecord)?.data || '')).toContain('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ');
  });

  test('drops unified-exec capacity warning and fills empty tool_result fallback', () => {
    const openaiPayload: AnyRecord = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_exec_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_exec_1',
          name: 'exec_command',
          content: ''
        },
        {
          role: 'user',
          content:
            'Warning: The maximum number of unified exec processes you can keep open is 60 and you currently have 64 processes open. Reuse older processes or close them to prevent automatic pruning of old processes'
        }
      ]
    };

    const anthropicRequest = buildAnthropicRequestFromOpenAIChat(openaiPayload) as AnyRecord;
    const anthropicMessages = asArray(anthropicRequest.messages) as AnyRecord[];

    expect(anthropicMessages).toHaveLength(2);
    const toolResultMsg = anthropicMessages[1] as AnyRecord;
    const toolResultBlock = firstBlockByType(toolResultMsg.content, 'tool_result');

    expect(String(toolResultBlock?.tool_use_id || '')).toBe('call_exec_1');
    expect(String(toolResultBlock?.content || '')).toBe(
      '[RouteCodex] Tool output was empty; execution status unknown.'
    );
  });
});
