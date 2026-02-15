import { describe, expect, it } from '@jest/globals';
import { buildGeminiToolsFromBridge } from '../../sharedmodule/llmswitch-core/src/conversion/shared/gemini-tool-utils.js';

describe('Gemini tool schema cleaning (antigravity)', () => {
  it('sanitizes functionDeclarations parameters for antigravity mode', () => {
    const tools = buildGeminiToolsFromBridge(
      [
        {
          type: 'function',
          function: {
            name: 'lookup-news',
            description: 'lookup latest news',
            parameters: {
              type: ['object', 'null'],
              properties: [
                {
                  key: 'literal',
                  value: {
                    const: 'stable',
                    description: 'fixed value'
                  }
                },
                {
                  key: 'choice',
                  value: {
                    description: 'pick one',
                    oneOf: [
                      { type: 'object', properties: { q: { type: 'string' } } },
                      { type: 'string' }
                    ]
                  }
                },
                {
                  key: 'threshold',
                  value: {
                    type: 'number',
                    exclusiveMinimum: 0
                  }
                },
                {
                  key: 'meta',
                  value: {
                    type: 'object',
                    propertyNames: { pattern: '^x-' },
                    additionalProperties: false
                  }
                }
              ],
              required: ['literal', 'missing'],
              patternProperties: { '^x-': { type: 'string' } },
              external_web_access: true,
              $schema: 'https://json-schema.org/draft/2020-12/schema'
            }
          }
        } as any
      ],
      { mode: 'antigravity' }
    ) as Array<Record<string, any>>;

    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);

    const decl = tools[0]?.functionDeclarations?.[0] as Record<string, any>;
    expect(decl).toBeDefined();
    expect(decl.name).toBe('lookup_news');

    const params = decl.parameters as Record<string, any>;
    expect(params.type).toBe('object');
    expect(params.patternProperties).toBeUndefined();
    expect(params.external_web_access).toBeUndefined();
    expect(params.$schema).toBeUndefined();
    expect(params.required).toEqual(['literal']);

    const props = params.properties as Record<string, any>;
    expect(props).toBeDefined();

    expect(props.literal.const).toBeUndefined();
    expect(props.literal.enum).toEqual(['stable']);

    expect(props.choice.oneOf).toBeUndefined();
    expect(props.choice.type).toBe('string');
    expect(props.choice.description).toBe('pick one');

    expect(props.threshold.exclusiveMinimum).toBeUndefined();
    expect(props.meta.propertyNames).toBeUndefined();
    expect(props.meta.additionalProperties).toBeUndefined();
  });
});
