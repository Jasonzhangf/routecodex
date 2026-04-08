import { sanitizeChatProcessRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.js';

describe('sanitizeChatProcessRequest', () => {
  it('removes empty/template assistant turns and keeps tool_calls turns', () => {
    const input: any = {
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: '   ' },
        {
          role: 'assistant',
          content: "I'm ready to help you with whatever you need. What would you like me to do?"
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        }
      ],
      metadata: { traceId: 't1' }
    };

    const out: any = sanitizeChatProcessRequest(input);

    expect(out.messages).toHaveLength(3);
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out.messages[2].tool_calls?.length).toBe(1);
    expect(out.metadata?.chatProcessSanitizer).toEqual({
      removedAssistantTurns: 2,
      removedEmptyAssistantTurns: 1,
      removedTemplateAssistantTurns: 1,
      removedToolTurns: 0,
      removedEmptyToolTurns: 0,
      removedOrphanToolTurns: 0,
      backfilledToolCallIds: 0
    });
  });

  it('supports array content and strips short template variant', () => {
    const input: any = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'm here to help. What would you like me to do?" }
          ]
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '实际业务回复' }]
        }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content[0].text).toBe('实际业务回复');
    expect(out.metadata?.chatProcessSanitizer?.removedTemplateAssistantTurns).toBe(1);
  });

  it('backfills single pending tool_call_id and drops orphan tool turns', () => {
    const input: any = {
      messages: [
        { role: 'user', content: 'run command' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        { role: 'tool', content: [{ type: 'text', text: 'orphan output' }] }
      ]
    };

    const out: any = sanitizeChatProcessRequest(input);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2].role).toBe('tool');
    expect(out.messages[2].tool_call_id).toBe('call_1');
    expect(out.metadata?.chatProcessSanitizer).toMatchObject({
      backfilledToolCallIds: 1,
      removedOrphanToolTurns: 1,
      removedToolTurns: 1
    });
  });
});
