import { describe, expect, test } from '@jest/globals';

import { mapChatToolsToAnthropicTools } from '../../src/conversion/shared/anthropic-message-utils.js';

describe('anthropic tool schema stability', () => {
  test('sanitizes codex builtin tool schema while preserving required keys', () => {
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
    expect(Array.isArray(anthropicTools)).toBe(true);
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

  test('keeps non-builtin tool schema unchanged', () => {
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
});
