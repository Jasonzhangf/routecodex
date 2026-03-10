import { describe, expect, test } from '@jest/globals';

import { buildGeminiToolsFromBridge } from '../../src/conversion/shared/gemini-tool-utils.js';

describe('gemini tool schema normalization (antigravity)', () => {
  test('converts properties [{key,value}] list into object map and normalizes union type + enum values', () => {
    const defs: any[] = [
      {
        type: 'function',
        function: {
          name: 'weird_tool',
          parameters: {
            type: 'object',
            properties: [
              { key: 'cmd', value: { type: ['string', 'null'] } },
              {
                key: 'nested',
                value: {
                  type: 'object',
                  properties: [{ key: 'flag', value: { type: ['boolean', 'null'] } }]
                }
              },
              { key: 'mode', value: { type: 'string', enum: [1, true, 'fast'] } }
            ],
            required: ['cmd', 'missing']
          }
        }
      }
    ];

    const tools = buildGeminiToolsFromBridge(defs as any, { mode: 'antigravity' });
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);

    const decls = (tools as any)[0]?.functionDeclarations;
    expect(Array.isArray(decls)).toBe(true);
    expect(decls).toHaveLength(1);

    const params = decls[0]?.parameters;
    expect(params).toBeTruthy();
    expect(params.type).toBe('object');
    expect(Array.isArray(params.properties)).toBe(false);
    expect(params.properties).toEqual(expect.objectContaining({ cmd: expect.anything(), nested: expect.anything() }));

    expect(params.properties.cmd.type).toBe('string');
    expect(params.properties.nested.properties.flag.type).toBe('boolean');
    expect(params.properties.mode.enum).toEqual(['1', 'true', 'fast']);
    expect(params.required).toEqual(['cmd']);
  });
});

