import { ChatSemanticMapper } from '../../src/conversion/hub/operation-table/semantic-mappers/chat-mapper.js';

describe('ChatSemanticMapper fast path', () => {
  test('maps simple openai chat payload without losing semantics', async () => {
    const mapper = new ChatSemanticMapper();
    const ctx = {
      requestId: 'req-fast',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
    };

    const result = await mapper.toChat(
      {
        protocol: 'openai-chat',
        direction: 'request',
        payload: {
          messages: [
            { role: 'system', content: 'sys-a' },
            { role: 'user', content: 'hello' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'bridge.exec',
                    arguments: '{"cmd":"pwd"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              name: 'exec',
              content: 'ok',
            },
          ],
          model: 'gpt-test',
          temperature: 0,
          custom_flag: 'keep-me',
        },
      } as any,
      ctx as any,
    );

    expect(result.messages).toHaveLength(4);
    expect(result.parameters).toMatchObject({
      model: 'gpt-test',
      temperature: 0,
    });
    expect(result.toolOutputs).toEqual([
      {
        tool_call_id: 'call_1',
        name: 'exec',
        content: 'ok',
      },
    ]);
    expect((result.messages[2] as any).tool_calls?.[0]?.function?.name).toBe('exec');
    expect(result.semantics).toMatchObject({
      system: {
        textBlocks: ['sys-a'],
      },
      providerExtras: {
        openaiChat: {
          extraFields: {
            custom_flag: 'keep-me',
          },
        },
      },
    });
    expect((result.metadata as any).context.requestId).toBe('req-fast');
    expect((result.metadata as any).protocolState.openai.systemMessages).toHaveLength(1);
  });
});
