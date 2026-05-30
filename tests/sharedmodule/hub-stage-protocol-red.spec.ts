import { describe, expect, it } from '@jest/globals';

import { serializeChatEventToSSE } from '../../sharedmodule/llmswitch-core/src/sse/shared/chat-serializer.js';
import { stripClientPayloadCrossProtocolFields } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.js';

type JsonRecord = Record<string, unknown>;

const RESPONSES_TOP_LEVEL_FIELDS = [
  'output',
  'output_text',
  'required_action',
  'previous_response_id',
  'response_id',
  'instructions',
  'input',
  'status'
] as const;

const CHAT_TOP_LEVEL_FIELDS = ['choices'] as const;
const RESPONSES_SSE_KEYWORDS = ['response.output_item', 'response.completed', 'response.created', 'response.function_call_arguments'] as const;
const CHAT_SSE_KEYWORDS = ['chat_chunk', 'chat.done'] as const;

function expectAbsent(payload: JsonRecord | string, fields: readonly string[]): void {
  if (typeof payload === 'string') {
    for (const field of fields) {
      expect(payload).not.toContain(field);
    }
    return;
  }
  for (const field of fields) {
    expect(payload).not.toHaveProperty(field);
  }
}

function expectCanonicalChatCompletion(payload: JsonRecord): void {
  expect(payload.object).toBe('chat.completion');
  expect(Array.isArray(payload.choices)).toBe(true);
  expectAbsent(payload, RESPONSES_TOP_LEVEL_FIELDS);
  const choice = (payload.choices as JsonRecord[])[0];
  expect(choice).toHaveProperty('message');
  expect(choice).not.toHaveProperty('item');
}

describe('hub stage protocol red guards', () => {
  it('inbound exit for openai-chat rejects Responses request/response fields', () => {
    const inboundExit: JsonRecord = {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }]
    };

    expect(inboundExit).toHaveProperty('messages');
    expectAbsent(inboundExit, RESPONSES_TOP_LEVEL_FIELDS);
    expect(JSON.stringify(inboundExit)).not.toContain('response.output_item');
  });

  it('chat_process response exit is canonical chat only, never Responses shape', () => {
    const chatProcessExit: JsonRecord = {
      id: 'chatcmpl_protocol_guard',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    };

    expectCanonicalChatCompletion(chatProcessExit);
    expect(JSON.stringify(chatProcessExit)).not.toContain('"object":"response"');
  });

  it('outbound chat payload strips Responses fields before client wire', () => {
    const outboundExit = stripClientPayloadCrossProtocolFields({
      id: 'chatcmpl_protocol_guard',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      output: [{ type: 'message', content: [] }],
      required_action: { submit_tool_outputs: { tool_calls: [] } },
      status: 'completed',
      input: [],
      instructions: 'responses-only'
    }, 'openai-chat') as JsonRecord;

    expectCanonicalChatCompletion(outboundExit);
  });

  it('outbound responses payload strips Chat choices before client wire', () => {
    const outboundExit = stripClientPayloadCrossProtocolFields({
      id: 'resp_protocol_guard',
      object: 'response',
      status: 'requires_action',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' }],
      required_action: { submit_tool_outputs: { tool_calls: [] } },
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }]
    }, 'openai-responses') as JsonRecord;

    expect(outboundExit.object).toBe('response');
    expect(outboundExit).toHaveProperty('output');
    expect(outboundExit).toHaveProperty('required_action');
    expectAbsent(outboundExit, CHAT_TOP_LEVEL_FIELDS);
  });

  it('chat SSE wire uses only data frames and never Responses event keywords', () => {
    const wire = serializeChatEventToSSE({
      event: 'chat_chunk',
      type: 'chat_chunk',
      timestamp: 1,
      sequenceNumber: 0,
      protocol: 'chat',
      direction: 'json_to_sse',
      data: JSON.stringify({
        id: 'chatcmpl_protocol_guard',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.5',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }]
      })
    });

    expect(wire).toMatch(/^data: /m);
    expect(wire).not.toMatch(/^event:/m);
    expectAbsent(wire, RESPONSES_SSE_KEYWORDS);
    expectAbsent(wire, CHAT_SSE_KEYWORDS);
  });

  it('round-trips openai-chat tool_calls without Responses fields', () => {
    const chatProcessExit: JsonRecord = {
      id: 'chatcmpl_roundtrip_guard',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_roundtrip_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      output: [{ type: 'function_call', call_id: 'call_wrong_protocol' }],
      required_action: { submit_tool_outputs: { tool_calls: [] } },
      status: 'requires_action'
    };

    const outboundExit = stripClientPayloadCrossProtocolFields(chatProcessExit, 'openai-chat') as JsonRecord;
    const wire = JSON.stringify(outboundExit);

    expectCanonicalChatCompletion(outboundExit);
    expect(wire).toContain('"tool_calls"');
    expect(wire).toContain('"exec_command"');
    expectAbsent(outboundExit, RESPONSES_TOP_LEVEL_FIELDS);
  });

  it('round-trips openai-responses function calls without Chat choices', () => {
    const responsesOutbound: JsonRecord = {
      id: 'resp_roundtrip_guard',
      object: 'response',
      status: 'requires_action',
      output: [{ type: 'function_call', call_id: 'call_roundtrip_1', name: 'exec_command', arguments: '{}' }],
      required_action: {
        submit_tool_outputs: {
          tool_calls: [{ id: 'call_roundtrip_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }]
        }
      },
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }]
    };

    const outboundExit = stripClientPayloadCrossProtocolFields(responsesOutbound, 'openai-responses') as JsonRecord;
    const wire = JSON.stringify(outboundExit);

    expect(outboundExit.object).toBe('response');
    expect(wire).toContain('"function_call"');
    expect(wire).toContain('"required_action"');
    expectAbsent(outboundExit, CHAT_TOP_LEVEL_FIELDS);
  });
});
