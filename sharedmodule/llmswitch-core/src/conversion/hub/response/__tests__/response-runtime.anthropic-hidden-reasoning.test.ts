import { describe, it, expect } from '@jest/globals';
import { buildOpenAIChatFromAnthropicMessage } from '../response-runtime.js';
import { buildResponsesPayloadFromChatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

describe('response-runtime anthropic hidden reasoning', () => {
  it('maps redacted_thinking into responses reasoning encrypted_content', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_hidden_only',
      type: 'message',
      role: 'assistant',
      model: 'glm-5',
      stop_reason: 'end_turn',
      content: [{ type: 'redacted_thinking', data: 'enc_payload_only' }]
    } as any);

    expect((chat as any).choices?.[0]?.message?.content).toBe('');
    expect((chat as any).__responses_reasoning?.encrypted_content).toBe('enc_payload_only');
    expect((chat as any).choices?.[0]?.message?.reasoning?.encrypted_content).toBe('enc_payload_only');
  });

  it('keeps public reasoning text and signature together', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_thinking_with_signature',
      type: 'message',
      role: 'assistant',
      model: 'glm-5',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', text: 'plan next action', signature: 'sig_payload' }]
    } as any);

    expect((chat as any).choices?.[0]?.message?.reasoning_content).toBe('plan next action');
    expect((chat as any).__responses_reasoning?.content?.[0]?.text).toBe('plan next action');
    expect((chat as any).__responses_reasoning?.encrypted_content).toBe('sig_payload');
    expect((chat as any).choices?.[0]?.message?.reasoning?.content?.[0]?.text).toBe('plan next action');
    expect((chat as any).choices?.[0]?.message?.reasoning?.encrypted_content).toBe('sig_payload');
  });

  it('prioritizes redacted_thinking encrypted content over thinking signature', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_signature_and_redacted',
      type: 'message',
      role: 'assistant',
      model: 'glm-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', text: 'plan next action', signature: 'sig_payload' },
        { type: 'redacted_thinking', data: 'enc_payload' }
      ]
    } as any);

    expect((chat as any).__responses_reasoning?.encrypted_content).toBe('enc_payload');
    expect((chat as any).choices?.[0]?.message?.reasoning?.encrypted_content).toBe('enc_payload');
  });

  it('keeps hidden reasoning after remap to responses payload', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_hidden_to_responses',
      type: 'message',
      role: 'assistant',
      model: 'glm-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', text: 'plan next action', signature: 'sig_payload' },
        { type: 'redacted_thinking', data: 'enc_payload' }
      ]
    } as any);

    const responses = buildResponsesPayloadFromChatWithNative(chat as any, { requestId: 'req_hidden_to_responses' }) as any;
    const outputItems = Array.isArray(responses?.output) ? responses.output : [];
    const reasoningItem = outputItems.find((item: any) => item?.type === 'reasoning');

    expect(reasoningItem?.encrypted_content).toBe('enc_payload');
    expect(reasoningItem?.content?.[0]?.text).toBe('plan next action');
  });
});
