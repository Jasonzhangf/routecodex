import {
  sanitizeGLMToolsSchema,
  sanitizeGLMToolsSchemaInPlace,
  sanitizeToolSchema
} from '../tool-schema.js';

describe('tool-schema native wrapper', () => {
  test('sanitizes shell command schema and removes strict', () => {
    const payload = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            strict: true,
            parameters: {
              properties: {
                command: {
                  oneOf: [{ type: 'string' }, { type: 'array' }],
                  description: ''
                }
              },
              required: ['workdir', 'command'],
              additionalProperties: null
            }
          }
        }
      ]
    } as any;

    const output = sanitizeGLMToolsSchema(payload);
    const toolFn = output.tools[0].function;
    expect(toolFn.strict).toBeUndefined();
    expect(toolFn.parameters.properties.command.type).toBe('array');
    expect(toolFn.parameters.properties.command.items).toEqual({ type: 'string' });
    expect(toolFn.parameters.properties.command.description).toBe(
      'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.'
    );
    expect(toolFn.parameters.required).toEqual(['workdir', 'command']);
    expect(toolFn.parameters.type).toBe('object');
    expect(toolFn.parameters.additionalProperties).toBe(false);
  });

  test('ensures command in required when required array is invalid', () => {
    const payload = {
      tools: [
        {
          function: {
            name: 'shell',
            parameters: {
              required: ['path', 1],
              additionalProperties: true
            }
          }
        }
      ]
    } as any;

    const output = sanitizeToolSchema(payload, 'glm_shell') as any;
    expect(output.tools[0].function.parameters.required).toEqual(['command']);
    expect(output.tools[0].function.parameters.additionalProperties).toBe(true);
  });

  test('in-place variant mutates original payload', () => {
    const payload = {
      tools: [
        {
          function: {
            name: 'shell',
            strict: false,
            parameters: {}
          }
        }
      ]
    } as any;

    sanitizeGLMToolsSchemaInPlace(payload);
    expect(payload.tools[0].function.strict).toBeUndefined();
    expect(payload.tools[0].function.parameters.properties.command.type).toBe('array');
    expect(payload.tools[0].function.parameters.required).toEqual(['command']);
  });
});
