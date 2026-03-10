import { describe, expect, test } from '@jest/globals';

import { buildServerToolFollowupChatPayloadFromInjection } from '../../src/servertool/handlers/followup-request-builder.js';

describe('servertool followup request builder', () => {
  test('preserves tools but strips tool-selection hints from the captured seed', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {
        stream: true,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        temperature: 0.7
      }
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(followup.model).toBe('gpt-test');
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages.length).toBe(2);

    expect(Array.isArray(followup.tools)).toBe(true);
    expect(followup.tools).toHaveLength(1);
    expect(followup.parameters).toBeTruthy();
    expect(followup.parameters.stream).toBeUndefined();
    expect(followup.parameters.tool_choice).toBeUndefined();
    expect(followup.parameters.parallel_tool_calls).toBe(true);
    expect(followup.parameters.temperature).toBe(0.7);
  });

  test('inject_vision_summary replaces image parts with placeholder', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        }
      ],
      parameters: {}
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'inject_vision_summary', summary: 'a cat' }] } as any
    });

    expect(followup).toBeTruthy();
    const msg = followup.messages?.[0];
    expect(msg?.role).toBe('user');
    expect(Array.isArray(msg?.content)).toBe(true);
    const types = (msg.content as any[]).map((p) => (typeof p?.type === 'string' ? String(p.type).toLowerCase() : ''));
    expect(types.some((t) => t.includes('image'))).toBe(false);
    const texts = (msg.content as any[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['[Image omitted]', '[Vision] a cat']));
  });

  test('append_user_text followup scrubs historical image payloads before marker analysis', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        },
        { role: 'assistant', content: 'ok' }
      ],
      parameters: {}
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages).toHaveLength(3);

    const historicalUser = followup.messages[0];
    expect(historicalUser?.role).toBe('user');
    expect(Array.isArray(historicalUser?.content)).toBe(true);
    const historicalTypes = (historicalUser.content as any[]).map((p) =>
      typeof p?.type === 'string' ? String(p.type).toLowerCase() : ''
    );
    expect(historicalTypes.some((t) => t.includes('image'))).toBe(false);
    const historicalTexts = (historicalUser.content as any[])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean);
    expect(historicalTexts).toContain('[Image omitted]');

    expect(followup.messages[2]).toEqual({ role: 'user', content: '继续' });
  });

  test('ensure_standard_tools injects review schema with strict required fields', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'review this change' }]
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'ensure_standard_tools' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(Array.isArray(followup.tools)).toBe(true);
    const reviewTool = (followup.tools as any[]).find(
      (tool) => tool?.type === 'function' && tool?.function?.name === 'review'
    );
    expect(reviewTool).toBeTruthy();
    expect(reviewTool.function.parameters?.required).toEqual(expect.arrayContaining(['goal', 'context', 'focus']));
  });
});
