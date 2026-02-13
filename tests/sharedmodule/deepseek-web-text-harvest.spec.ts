import { applyDeepSeekWebResponseTransform } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-response.js';

describe('deepseek-web text tool-call harvest', () => {
  const adapterContext: any = {
    capturedChatRequest: {
      tools: [{ type: 'function', function: { name: 'apply_patch' } }],
      tool_choice: 'required'
    }
  };

  it('harvests apply_patch from text-wrapped JSON when input is malformed object-like string', () => {
    const content = [
      'Here is the corrected patch:',
      '{"tool_calls":[{"name":"apply_patch","input":"{patch:\\"*** Begin Patch\\\\n*** Add File: sample.txt\\\\n+ok\\\\n*** End Patch\\"}"}]}'
    ].join('\n');

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContext);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(String(args.patch || args.input || '')).toContain('*** Begin Patch');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('harvests when tool_calls field itself is a JSON string', () => {
    const content =
      '{"tool_calls":"[{\\"name\\":\\"apply_patch\\",\\"input\\":{\\"patch\\":\\"*** Begin Patch\\\\n*** Add File: sample2.txt\\\\n+ok\\\\n*** End Patch\\"}}]"}';

    const payload: any = {
      id: 'chatcmpl_deepseek_harvest_2',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, adapterContext);
    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(String(args.patch || args.input || '')).toContain('*** Begin Patch');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
