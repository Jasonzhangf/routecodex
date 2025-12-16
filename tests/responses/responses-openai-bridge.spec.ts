import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';

describe('buildResponsesRequestFromChat (responses bridge)', () => {
  it('mirrors apply_patch arguments into both patch and input fields', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: demo.txt',
      '@@',
      '- foo',
      '+ bar',
      '*** End Patch'
    ].join('\n');

    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '请修改文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_apply_patch',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patchText })
              }
            }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    };

    const result = buildResponsesRequestFromChat(payload, {});
    const inputEntries = Array.isArray((result.request as any).input) ? (result.request as any).input : [];
    const fnCall = inputEntries.find(
      (entry: any) => entry?.type === 'function_call' && entry?.name === 'apply_patch'
    );
    expect(fnCall).toBeTruthy();
    const parsedArgs = JSON.parse(fnCall.arguments);
    expect(parsedArgs.patch).toBe(patchText);
    expect(parsedArgs.input).toBe(patchText);
  });

  it('throws when apply_patch arguments are missing patch/input', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_apply_patch_empty',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '{}'
              }
            }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).toThrow(/apply_patch arguments missing/i);
  });
});
