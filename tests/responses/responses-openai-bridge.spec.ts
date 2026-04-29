import { jest } from '@jest/globals';

const nativeBridgeActions = await import(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js'
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js',
  () => ({
    ...nativeBridgeActions,
    runBridgeActionPipelineWithNative: ({ state }: { state?: { messages?: unknown[] } }) => ({
      messages: Array.isArray(state?.messages) ? state.messages : []
    })
  })
);

const { buildResponsesRequestFromChat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js'
);

describe('buildResponsesRequestFromChat (responses bridge)', () => {
  it('preserves apply_patch arguments when converting tool_calls to Responses input', () => {
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
        },
        {
          role: 'tool',
          tool_call_id: 'call_apply_patch',
          name: 'apply_patch',
          content: 'patch applied'
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
    expect(parsedArgs.input).toBeUndefined();
  });

  it('does not fail-close when apply_patch arguments are missing patch/input', () => {
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
        },
        {
          role: 'tool',
          tool_call_id: 'call_apply_patch_empty',
          name: 'apply_patch',
          content: 'empty patch result'
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

    expect(() => buildResponsesRequestFromChat(payload, {})).not.toThrow();
    const result = buildResponsesRequestFromChat(payload, {});
    const inputEntries = Array.isArray((result.request as any).input) ? (result.request as any).input : [];
    const fnCall = inputEntries.find(
      (entry: any) => entry?.type === 'function_call' && entry?.name === 'apply_patch'
    );
    expect(fnCall).toBeTruthy();
    expect(fnCall.arguments).toBe('{}');
  });

  it('fails fast when incoming history contains synthetic RouteCodex fallback tool ids', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_servertool_fallback_1777378574502_510',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo hi' })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_servertool_fallback_1777378574502_510',
          name: 'exec_command',
          content: 'ok'
        }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).toThrow(
      /synthetic RouteCodex fallback id/i
    );
  });

  it('fails fast when incoming history contains synthetic RouteCodex local control text', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '[RouteCodex] assistant response became empty after response sanitization.' }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).toThrow(
      /synthetic RouteCodex local control text/i
    );
  });
});
