import { describe, expect, test } from '@jest/globals';

import { mapChatToolsToAnthropicToolsWithNative as mapChatToolsToAnthropicTools } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tool-definitions.js';

describe('anthropic tool schema stability (root regression)', () => {
  test('sanitizes builtin exec_command schema while preserving required keys', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'run shell command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'command' },
              workdir: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
                description: 'working directory'
              },
              extra: {
                type: 'object',
                properties: { nested: { type: 'string' } }
              }
            },
            required: ['cmd'],
            additionalProperties: true,
            oneOf: [{ required: ['cmd'] }]
          }
        }
      }
    ];

    const anthropicTools = mapChatToolsToAnthropicTools(tools) as any[];
    expect(anthropicTools).toHaveLength(1);

    const schema = anthropicTools[0].input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['cmd']);
    expect(schema).not.toHaveProperty('oneOf');

    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['cmd', 'workdir']);
    expect((properties.cmd as Record<string, unknown>).type).toBe('string');
  });

  test('keeps custom tool schema unchanged', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'custom_tool',
          parameters: {
            type: 'object',
            properties: {
              payload: {
                anyOf: [{ type: 'string' }, { type: 'number' }]
              }
            },
            required: ['payload']
          }
        }
      }
    ];

    const anthropicTools = mapChatToolsToAnthropicTools(tools) as any[];
    const schema = anthropicTools[0].input_schema as Record<string, unknown>;
    expect((schema.properties as any).payload.anyOf).toBeDefined();
    expect(schema.required).toEqual(['payload']);
  });

  test('preserves nested request_user_input schema for goal continuation feedback', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'request_user_input',
          description: 'ask user',
          parameters: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                description: 'Questions to show the user. Prefer 1 and do not exceed 3',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable identifier for mapping answers (snake_case).' },
                    header: { type: 'string', description: 'Short header label shown in the UI (12 or fewer chars).' },
                    question: { type: 'string', description: 'Single-sentence prompt shown to the user.' },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          label: { type: 'string', description: 'User-facing label (1-5 words).' },
                          description: { type: 'string', description: 'One short sentence explaining impact/tradeoff if selected.' }
                        },
                        required: ['label', 'description'],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ['id', 'header', 'question', 'options'],
                  additionalProperties: false
                }
              }
            },
            required: ['questions'],
            additionalProperties: false
          }
        }
      }
    ];

    const anthropicTools = mapChatToolsToAnthropicTools(tools) as any[];
    expect(anthropicTools).toHaveLength(1);

    const schema = anthropicTools[0].input_schema as Record<string, unknown>;
    const questions = (schema.properties as any).questions;
    expect(schema.required).toEqual(['questions']);
    expect(questions.type).toBe('array');
    expect(questions.items.type).toBe('object');
    expect(questions.items.required).toEqual(['id', 'header', 'question', 'options']);
    expect(questions.items.additionalProperties).toBe(false);
    expect(Object.keys(questions.items.properties).sort()).toEqual(['header', 'id', 'options', 'question']);
    expect(questions.items.properties.options.type).toBe('array');
    expect(questions.items.properties.options.items.type).toBe('object');
    expect(questions.items.properties.options.items.required).toEqual(['label', 'description']);
    expect(Object.keys(questions.items.properties.options.items.properties).sort()).toEqual(['description', 'label']);
  });

  test('preserves apply_patch servertool line-edit fields from chat process contract for anthropic outbound', () => {
    const tools: any[] = [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description:
            'Edit files through servertool apply_patch. Provide `filePath` and write `patch` in line-edit syntax.',
          parameters: {
            type: 'object',
            properties: {
              patch: { type: 'string', description: 'servertool line-edit patch text' },
              filePath: { type: 'string', description: 'target file path' },
              fileContent: { type: 'string', description: 'current file content' }
            },
            required: ['patch'],
            additionalProperties: false
          }
        }
      }
    ];

    const anthropicTools = mapChatToolsToAnthropicTools(tools) as any[];
    expect(anthropicTools).toHaveLength(1);

    const schema = anthropicTools[0].input_schema as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      'fileContent',
      'filePath',
      'patch'
    ]);
    expect(schema.required).toEqual(['patch']);
  });
});
