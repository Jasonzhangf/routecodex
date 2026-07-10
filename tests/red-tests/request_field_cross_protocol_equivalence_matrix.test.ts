import {
  buildChatRequestFromResponses,
  buildResponsesRequestFromChat,
  captureResponsesContext,
} from '../sharedmodule/helpers/responses-openai-bridge-direct-native.js';

type Obj = Record<string, any>;

function findTool(tools: unknown[], name: string): any {
  return tools.find((tool: any) => tool?.function?.name === name || tool?.name === name);
}

function responseInputTexts(input: unknown[]): string[] {
  const texts: string[] = [];
  for (const item of input as any[]) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') texts.push(part.text);
    }
  }
  return texts;
}

describe('request field cross-protocol equivalence matrix', () => {
  it('maps Responses request fields into chat semantics and back without metadata/raw backfill', () => {
    const responsesRequest: Obj = {
      model: 'gpt-equivalence',
      instructions: 'system contract',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'run one command' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'fc_1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'pwd' }),
        },
        {
          type: 'function_call_output',
          call_id: 'fc_1',
          output: 'ok',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'run shell',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_output_tokens: 123,
      temperature: 0.2,
      top_p: 0.9,
      response_format: { type: 'json_object' },
      store: false,
      include: ['reasoning.encrypted_content'],
      service_tier: 'default',
      truncation: 'auto',
    };

    const context: any = captureResponsesContext(responsesRequest, { route: { requestId: 'req_equivalence_matrix' } });
    context.metadata = {
      tool_choice: 'required',
      parallel_tool_calls: false,
      parameters: { max_output_tokens: 999 },
      __raw_request_body: {
        tools: [{ type: 'namespace', name: 'bad_namespace', tools: [] }],
      },
    };
    context.toolsRaw = [{ type: 'namespace', name: 'bad_namespace', tools: [] }];

    const chat = buildChatRequestFromResponses(responsesRequest, context).request as Obj;

    expect(chat.model).toBe('gpt-equivalence');
    expect(chat.messages.map((message: any) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(chat.messages[0].content).toBe('system contract');
    expect(chat.messages[1].content).toBe('run one command');
    expect(chat.messages[2].tool_calls?.[0]).toMatchObject({ id: 'fc_1', type: 'function' });
    expect(chat.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'fc_1', content: 'ok' });
    expect(findTool(chat.tools ?? [], 'exec_command')).toBeTruthy();
    expect(chat.tool_choice).toBe('auto');
    expect(chat.parallel_tool_calls).toBe(true);
    expect(chat.max_output_tokens).toBe(123);
    expect(chat.temperature).toBe(0.2);
    expect(chat.top_p).toBe(0.9);
    expect(JSON.stringify(chat)).not.toContain('bad_namespace');
    expect(JSON.stringify(chat)).not.toContain('__raw_request_body');

    const responsesBack = buildResponsesRequestFromChat(chat, context).request as Obj;
    expect(responsesBack.model).toBe('gpt-equivalence');
    expect(responsesBack.instructions).toContain('system contract');
    expect(responseInputTexts(responsesBack.input ?? [])).toContain('run one command');
    expect((responsesBack.input ?? []).some((item: any) => item?.type === 'function_call' && item?.name === 'exec_command')).toBe(true);
    expect((responsesBack.input ?? []).some((item: any) => item?.type === 'function_call_output' && item?.call_id === 'fc_1')).toBe(true);
    expect(findTool(responsesBack.tools ?? [], 'exec_command')).toBeTruthy();
    expect(responsesBack.tool_choice).toBe('auto');
    expect(responsesBack.parallel_tool_calls).toBe(true);
    expect(responsesBack.max_output_tokens).toBe(123);
    expect(responsesBack.response_format).toEqual({ type: 'json_object' });
    expect(responsesBack.service_tier).toBe('default');
    expect(responsesBack.truncation).toBe('auto');
    expect(JSON.stringify(responsesBack)).not.toContain('bad_namespace');
    expect(JSON.stringify(responsesBack)).not.toContain('__raw_request_body');
  });

  it('does not let context metadata override chat request fields during chat to Responses projection', () => {
    const chatRequest: Obj = {
      model: 'gpt-chat-source',
      messages: [{ role: 'user', content: 'use declared tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'declared_tool', parameters: { type: 'object', properties: {} } },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_output_tokens: 77,
      response_format: { type: 'json_object' },
    };

    const responses = buildResponsesRequestFromChat(chatRequest, {
      toolChoice: 'required',
      parallelToolCalls: false,
      parameters: { max_output_tokens: 999 },
      metadata: {
        tools: [{ type: 'namespace', name: 'bad_namespace', tools: [] }],
        tool_choice: 'none',
      },
    } as any).request as Obj;

    expect(responses.model).toBe('gpt-chat-source');
    expect(findTool(responses.tools ?? [], 'declared_tool')).toBeTruthy();
    expect(responses.tool_choice).toBe('auto');
    expect(responses.parallel_tool_calls).toBe(true);
    expect(responses.max_output_tokens).toBe(77);
    expect(responses.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(responses)).not.toContain('bad_namespace');
  });
});
