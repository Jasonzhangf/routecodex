import { describe, expect, it } from '@jest/globals';
import { stripClientPayloadCrossProtocolFields } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.js';

describe('client remap protocol field guard', () => {
  it('removes Responses-only top-level fields from OpenAI chat client payloads', () => {
    const payload = stripClientPayloadCrossProtocolFields({
      id: 'chatcmpl_guard',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      output: [{ type: 'function_call', call_id: 'call_1' }],
      output_text: '',
      required_action: { submit_tool_outputs: { tool_calls: [] } },
      previous_response_id: 'resp_prev',
      response_id: 'resp_1',
      instructions: 'responses-only',
      input: [],
      status: 'requires_action'
    }, 'openai-chat');

    expect(payload).toMatchObject({
      id: 'chatcmpl_guard',
      object: 'chat.completion',
      model: 'gpt-5.5'
    });
    expect(payload).toHaveProperty('choices');
    for (const field of ['output', 'output_text', 'required_action', 'previous_response_id', 'response_id', 'instructions', 'input', 'status']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('removes Chat-only choices from Responses client payloads', () => {
    const payload = stripClientPayloadCrossProtocolFields({
      id: 'resp_guard',
      object: 'response',
      status: 'requires_action',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' }],
      required_action: { submit_tool_outputs: { tool_calls: [] } },
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'tool_calls' }]
    }, 'openai-responses');

    expect(payload).toHaveProperty('output');
    expect(payload).toHaveProperty('required_action');
    expect(payload).not.toHaveProperty('choices');
  });
});
