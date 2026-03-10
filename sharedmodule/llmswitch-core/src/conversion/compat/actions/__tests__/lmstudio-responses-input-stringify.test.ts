import { stringifyLmstudioResponsesInput } from '../lmstudio-responses-input-stringify.js';

describe('lmstudio-responses-input-stringify native wrapper', () => {
  const envKeys = [
    'LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT',
    'ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT'
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT = '1';
    delete process.env.ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT;
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('stringifies responses input items when env gate is enabled', () => {
    const payload: any = {
      instructions: 'Follow tool calling.',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Please call exec_command.' }]
        },
        {
          type: 'function_call',
          name: 'exec_command',
          arguments: { cmd: 'pwd' }
        }
      ]
    };

    const result = stringifyLmstudioResponsesInput(payload, {
      providerProtocol: 'openai-responses'
    } as any) as any;

    expect(typeof result.input).toBe('string');
    expect(result.input).toContain('Follow tool calling.');
    expect(result.input).toContain('user: Please call exec_command.');
    expect(result.input).toContain('assistant tool_call exec_command');
  });

  test('keeps payload unchanged for non-responses protocols', () => {
    const payload: any = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
    };

    const result = stringifyLmstudioResponsesInput(payload, {
      providerProtocol: 'openai-chat'
    } as any) as any;

    expect(Array.isArray(result.input)).toBe(true);
    expect(result.input[0].role).toBe('user');
  });
});
