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

  it('accepts anthropic thinking blocks that use the thinking field', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_thinking_field_only',
      type: 'message',
      role: 'assistant',
      model: 'mimo-v2.5-pro',
      stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: 'The user says \"只回复 ok', signature: 'sig_payload' }]
    } as any);

    expect((chat as any).choices?.[0]?.finish_reason).toBe('length');
    expect((chat as any).choices?.[0]?.message?.content).toBe('');
    expect((chat as any).choices?.[0]?.message?.reasoning_content).toBe('The user says \"只回复 ok');
    expect((chat as any).choices?.[0]?.message?.reasoning?.content?.[0]?.text).toBe('The user says \"只回复 ok');
    expect((chat as any).choices?.[0]?.message?.reasoning?.encrypted_content).toBe('sig_payload');

    const responses = buildResponsesPayloadFromChatWithNative(chat as any, { requestId: 'req_hidden_thinking_field' }) as any;
    const reasoningItem = Array.isArray(responses?.output)
      ? responses.output.find((item: any) => item?.type === 'reasoning')
      : undefined;
    expect(responses?.model).toBe('mimo-v2.5-pro');
    expect(reasoningItem?.content?.[0]?.text).toBe('The user says \"只回复 ok');
    expect(reasoningItem?.encrypted_content).toBe('sig_payload');
  });

  it('drops meaningless dot-only thinking blocks so they do not enter reasoning history', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_dot_only_thinking',
      type: 'message',
      role: 'assistant',
      model: 'mimo-v2.5-pro',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '.' }]
    } as any);

    expect((chat as any).choices?.[0]?.message?.reasoning).toBeUndefined();
    expect((chat as any).choices?.[0]?.message?.reasoning_content).toBeUndefined();
    expect((chat as any).choices?.[0]?.message?.content).toBe('');
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
    const summaryText = typeof reasoningItem?.summary?.[0]?.text === 'string'
      ? String(reasoningItem.summary[0].text)
      : '';
    const contentText = typeof reasoningItem?.content?.[0]?.text === 'string'
      ? String(reasoningItem.content[0].text)
      : '';
    const recoveredReasoningText = contentText || summaryText.replace(/^\*\*Thinking\*\*\s*/i, '').trim();

    expect(reasoningItem?.encrypted_content).toBe('enc_payload');
    expect(recoveredReasoningText).toContain('plan next action');
  });

  it('fails fast when upstream returns model_context_window_exceeded with empty output', () => {
    expect(() => {
      buildOpenAIChatFromAnthropicMessage({
        id: 'msg_context_overflow',
        type: 'message',
        role: 'assistant',
        model: 'glm-4.7',
        stop_reason: 'model_context_window_exceeded',
        content: []
      } as any);
    }).toThrow(/model_context_window_exceeded/i);
  });

  it('maps context overflow stop reason to length when output text exists', () => {
    const chat = buildOpenAIChatFromAnthropicMessage({
      id: 'msg_context_overflow_with_text',
      type: 'message',
      role: 'assistant',
      model: 'glm-4.7',
      stop_reason: 'context_window_exceeded',
      content: [{ type: 'text', text: 'partial output' }]
    } as any);

    expect((chat as any).choices?.[0]?.finish_reason).toBe('length');
    expect((chat as any).choices?.[0]?.message?.content).toBe('partial output');
  });

  it('fails fast when upstream returns max_tokens with empty output', () => {
    expect(() => {
      buildOpenAIChatFromAnthropicMessage({
        id: 'msg_empty_max_tokens',
        type: 'message',
        role: 'assistant',
        model: 'mimo-v2.5-pro',
        stop_reason: 'max_tokens',
        content: []
      } as any);
    }).toThrow(/max_tokens/i);
  });
});
