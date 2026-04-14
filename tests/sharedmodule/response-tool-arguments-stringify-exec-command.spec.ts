import { ResponseToolArgumentsStringifyFilter } from '../../sharedmodule/llmswitch-core/src/filters/special/response-tool-arguments-stringify.js';

describe('ResponseToolArgumentsStringifyFilter exec_command raw shape', () => {
  it('preserves command-only exec_command args for client-side validation', () => {
    const filter = new ResponseToolArgumentsStringifyFilter();
    const input: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_filter_nested_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: {
                    command: 'pwd',
                    workdir: '/workspace',
                    yield_time_ms: 200
                  }
                }
              }
            ]
          }
        }
      ]
    };

    const result = filter.apply(input);
    expect(result.ok).toBe(true);
    const args = JSON.parse(String((result.data as any).choices[0].message.tool_calls[0].function.arguments || '{}'));
    expect(args.command).toBe('pwd');
    expect(args.cmd).toBeUndefined();
    expect(args.workdir).toBe('/workspace');
    expect(args.yield_time_ms).toBe(200);
  });
});
