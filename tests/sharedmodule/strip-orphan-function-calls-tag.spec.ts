import { stripOrphanFunctionCallsTag } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/strip-orphan-function-calls-tag.js';

describe('strip orphan function/tool closing tags', () => {
  it('removes orphan closing tags from chat content', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Let me check file.\n</parameter>\n</function>\n</tool_call>'
          }
        }
      ]
    } as any;

    const sanitized = stripOrphanFunctionCallsTag(payload as any) as any;
    expect(sanitized.choices[0].message.content).toBe('Let me check file.');
  });

  it('removes orphan function_calls tag lines from responses output_text', () => {
    const payload = {
      output: [
        {
          type: 'message',
          role: 'assistant',
          output_text: 'ok\n</function_calls>'
        }
      ]
    } as any;

    const sanitized = stripOrphanFunctionCallsTag(payload as any) as any;
    expect(sanitized.output[0].output_text).toBe('ok');
  });

  it('keeps normal text unchanged', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'No orphan tags here.'
          }
        }
      ]
    } as any;

    const sanitized = stripOrphanFunctionCallsTag(payload as any) as any;
    expect(sanitized.choices[0].message.content).toBe('No orphan tags here.');
  });
});
