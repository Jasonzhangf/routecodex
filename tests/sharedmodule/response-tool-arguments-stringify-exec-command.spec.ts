import { ResponseToolArgumentsStringifyFilter } from '../../sharedmodule/llmswitch-core/src/filters/special/response-tool-arguments-stringify.js';

describe('ResponseToolArgumentsStringifyFilter exec_command shape repair', () => {
  it('unwraps nested input.cmd shape into canonical exec_command args', () => {
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
                    input: {
                      cmd: 'pwd',
                      workdir: '/workspace',
                      yield_time_ms: 200
                    }
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
    expect(args.cmd).toBe('pwd');
    expect(args.workdir).toBe('/workspace');
    expect(args.yield_time_ms).toBe(200);
  });
});
